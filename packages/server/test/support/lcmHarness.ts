// A chat with LCM on, three models behind one mock provider (the summarizer's, a judge and a
// fallback), and the summarizer's own `runJob` so a test drives jobs one at a time.
import type { ServerResponse } from "node:http"
import { it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../../src/db/Database.ts"
import type { SummaryJob } from "../../src/db/lcmJobs.ts"
import type { AppendResult } from "../../src/db/ops.ts"
import { importStPreset } from "../../src/formats/preset.ts"
import { makeSummarizer, Summarizer } from "../../src/lcm/Summarizer.ts"
import { Layer } from "effect"
import type { AppConfigShape } from "../../src/config.ts"
import { client, serverLayer, testConfig } from "./config.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./mockProvider.ts"

/** What a model answers: text, a provider's refusal, or an HTTP failure. */
export type Reply = { readonly text: string } | { readonly refusal: true } | { readonly status: number }

export const PLANTED = "PLANTED-REFUSAL"

const reply = (res: ServerResponse, answer: Reply) => {
  if ("status" in answer) {
    res.writeHead(answer.status, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "synthetic failure" } }))
  } else if ("refusal" in answer)
    sse(res, [
      {
        id: "refusal",
        object: "chat.completion.chunk",
        model: "synthetic",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "content_filter" }]
      }
    ])
  else sse(res, completionChunks([answer.text], { prompt_tokens: 100, completion_tokens: 12 }))
}

export const lastText = (request: Recorded) => {
  const messages = (request.body?.messages ?? []) as Array<{ content: string | Array<{ text?: string }> }>
  const content = messages.at(-1)?.content
  return typeof content === "string" ? content : (content?.map((p) => p.text ?? "").join("") ?? "")
}

/**
 * The test server with a summarizer that has no background pool, so the test claims and runs
 * jobs itself; `summarizer()` is that instance.
 */
export const lcmServer = (config: AppConfigShape = testConfig(), pool = false) => {
  let captured: Summarizer["Service"] | undefined
  const layer = Layer.effect(
    Summarizer,
    Effect.tap(makeSummarizer(pool), (s) =>
      Effect.sync(() => {
        captured = s
      })
    )
  )
  return { config, layer: serverLayer(config, undefined, layer), summarizer: () => captured! }
}

/** A test with its own server, data directory and summarizer. */
export const lcmTest = <E, R>(
  name: string,
  body: (server: ReturnType<typeof lcmServer>) => Effect.Effect<void, E, R>,
  options: { readonly timeout?: number; readonly pool?: boolean } = {}
) =>
  it.live(
    name,
    () => {
      const server = lcmServer(testConfig(), options.pool)
      return body(server).pipe(Effect.provide(server.layer)) as Effect.Effect<void, unknown, never>
    },
    options.timeout ?? 60_000
  )

export const lcmHarness = (
  server: { readonly config: AppConfigShape; readonly summarizer: () => Summarizer["Service"] },
  options: {
    readonly messages?: number
    readonly summarizer?: (request: Recorded) => Reply
    readonly judge?: (request: Recorded) => Reply
    readonly fallback?: (request: Recorded) => Reply
    readonly settings?: Record<string, unknown>
  } = {}
) =>
  Effect.gen(function* () {
    const behavior = {
      primary: options.summarizer ?? ((): Reply => ({ text: "A summary." })),
      // The fake judge: it says REFUSED for text the test planted, and nothing else.
      judge: options.judge ?? ((r: Recorded): Reply => ({ text: lastText(r).includes(PLANTED) ? "REFUSED" : "OK" })),
      fallback: options.fallback ?? ((): Reply => ({ text: "A fallback summary." }))
    }
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) => {
          const key = String(request.body?.model ?? "")
          reply(
            res,
            key === "judge-model"
              ? behavior.judge(request)
              : key === "fallback-model"
                ? behavior.fallback(request)
                : behavior.primary(request)
          )
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client(),
      writer = yield* Writer,
      reader = yield* Reader,
      summarizer = server.summarizer(),
      user = yield* api.Whoami(),
      userId = user.id as UserId
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Synthetic",
        baseUrl: `${mock.url}/v1`,
        compat: {},
        cacheTtlS: 300,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const model = (key: string) =>
      Effect.map(
        api.AddUserModel({ connectionId: connection.id, key, overrides: { context: 8192, tools: true } }),
        (m) => ({ connection: connection.id, model: m.id })
      )
    const primary = yield* model("primary-model"),
      judge = yield* model("judge-model"),
      fallback = yield* model("fallback-model")
    const preset = yield* writer.CreateEntity({
      userId,
      kind: "preset",
      label: "Synthetic",
      subtitle: "",
      schemaVersion: 1,
      origin: "user",
      sourcePath: null,
      doc: importStPreset(JSON.stringify({ frequency_penalty: 0, openai_max_context: 8192, openai_max_tokens: 512 }))
        .document!
    })
    const defaults = (extra: { judge?: typeof judge; fallback?: typeof fallback; spendAhead?: boolean } = {}) =>
      api.SetGenerationDefaults({
        defaults: {
          model: primary,
          preset: preset.ref.id,
          ...(extra.judge ? { judge: extra.judge } : { judge: null }),
          lcm: {
            ...(extra.fallback ? { fallback: extra.fallback } : {}),
            ...(extra.spendAhead === undefined ? {} : { spendAhead: extra.spendAhead })
          }
        }
      })
    yield* defaults()
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "LCM",
      participants: [],
      greeting: null
    })
    yield* writer.AddStateEvent({
      userId,
      chatId: chat.id,
      slotId: null,
      versionId: null,
      scope: null,
      data: { key: "lcm.settings", value: { enabled: true, leafInput: 500, leafTarget: 100, ...options.settings } }
    })
    const rows: Array<AppendResult> = []
    const append = (content: string, parent: SlotId | null = rows.at(-1)?.slotId ?? null, branch = false) =>
      Effect.tap(
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId: parent,
          branch,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        }),
        (row) => Effect.sync(() => void rows.push(row))
      )
    for (let n = 0; n < (options.messages ?? 8); n++) yield* append(`Message ${n}. ` + "The road ran on. ".repeat(10))

    /** Enqueues one L1 job over the messages `from` to `to` (inclusive) of the path. */
    const enqueue = (from: number, to: number, requestClass: "interactive" | "idle" | "background" = "interactive") =>
      Effect.gen(function* () {
        const leaf = rows.at(-1)!.slotId
        const path = yield* reader.GetPath({ userId, chatId: chat.id, leafSlotId: null, limit: 500 })
        const chunk = {
          target: Number(options.settings?.leafTarget ?? 100),
          inputs: path.entries
            .slice(from, to + 1)
            .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: e.version.rowVersion - 1 }))
        }
        const [job] = yield* writer.EnqueueSummaries({
          userId,
          chatId: chat.id,
          leafSlotId: leaf,
          chunks: [chunk],
          requestClass
        })
        return job!
      })
    /** Plans as after a reply (or, with "completion", as after a finished job) and enqueues; the jobs made. */
    const plan = (reason: "reply" | "completion" = "reply") =>
      summarizer.planNow({ userId, chatId: chat.id, leafSlotId: rows.at(-1)!.slotId }, reason)
    /** Plans and runs everything to quiescence, as a reply and its cascade would; every job that ran. */
    const settle = Effect.gen(function* () {
      const ran: Array<SummaryJob> = []
      let reason: "reply" | "completion" = "reply"
      for (let pass = 0; pass < 20; pass++) {
        const made = yield* plan(reason)
        const done = yield* drain
        ran.push(...done)
        if (!made.length && !done.length) break
        reason = "completion"
      }
      return ran
    })
    /** Claims the next job and runs it to its outcome; null when nothing could be claimed. */
    const runNext = Effect.gen(function* () {
      const job = yield* writer.ClaimSummaryJob({ userId })
      if (job) yield* summarizer.runJob(job)
      return job
    })
    const drain = Effect.gen(function* () {
      const ran: Array<SummaryJob> = []
      for (let n = 0; n < 40; n++) {
        const job = yield* runNext
        if (!job) break
        ran.push(job)
      }
      return ran
    })
    return {
      dataDir: server.config.dataDir,
      mock,
      api,
      writer,
      reader,
      summarizer,
      user,
      userId,
      connection,
      primary,
      judge,
      fallback,
      chat,
      rows,
      append,
      enqueue,
      plan,
      settle,
      runNext,
      drain,
      defaults,
      preset
    }
  })

export const requestsTo = (mock: { requests: () => ReadonlyArray<Recorded> }, key: string) =>
  mock.requests().filter((r) => r.body?.model === key)
