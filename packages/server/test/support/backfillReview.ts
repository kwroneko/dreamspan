// Enabling LCM on imported chats and backfilling them (spec/LCM.md §2.7, §2.11) at the real
// boundary: a synthetic ST folder uploaded over HTTP as the client does, the enable dialog's
// reads and writes through the RPCs, summaries planned and written by the real summarizer
// against a fake provider that caches prefixes as a provider would, and the estimate checked
// against the usage ledger. Cross-user probes are in isolation.test.ts.
import type { ServerResponse } from "node:http"
import { assert } from "@effect/vitest"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { LlmRequest } from "@rp/shared/usage.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../../src/db/Database.ts"
import { importStPreset } from "../../src/formats/preset.ts"
import { client } from "./config.ts"
import { fixtureSql } from "./lcmFixtures.ts"
import { lcmServer } from "./lcmHarness.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./mockProvider.ts"
import { backfillFolder } from "./stBackfill.ts"
import { importStFolder } from "./stUpload.ts"

const tokens = (text: string) => Math.ceil(text.length / 4) + 3
const flat = (content: unknown) =>
  typeof content === "string" ? content : (content as Array<{ text?: string }>).map((p) => p.text ?? "").join("")

const L1_TOKENS = 100
const CONDENSED_TOKENS = 150

/**
 * A provider that answers every request with a summary of the size asked for, and reports the
 * usage a provider with prefix caching would: the text it shares with the request before, from
 * the start, in tokens.
 */
const cachingProvider = () => {
  let previous = ""
  let n = 0
  return (request: Recorded, res: ServerResponse) => {
    const messages = (request.body?.messages ?? []) as Array<{ role: string; content: unknown }>
    const wire = messages.map((m) => `${m.role}\u0000${flat(m.content)}`).join("\u0001")
    let shared = 0
    while (shared < wire.length && wire[shared] === previous[shared]) shared++
    previous = wire
    const condense = flat(messages.at(-1)?.content).includes("Condense the last")
    const size = condense ? CONDENSED_TOKENS : L1_TOKENS
    const text = `Summary ${++n}. `.padEnd(size * 4, "x")
    sse(
      res,
      completionChunks([text], {
        prompt_tokens: messages.reduce((sum, m) => sum + tokens(flat(m.content)), 0),
        completion_tokens: Math.ceil(text.length / 4),
        prompt_tokens_details: { cached_tokens: Math.floor(shared / 4) }
      })
    )
  }
}

/** Dollars per million tokens for the test model, through the built-in formula. */
const PRICE = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }

/** A server's worth of setup: the fake provider, a priced model, the folder imported, and helpers to drive the work. */
export const environment = (
  server: ReturnType<typeof lcmServer>,
  names: ReadonlyArray<string>,
  handler = cachingProvider(),
  folderOptions = {},
  transform = (files: ReadonlyMap<string, Uint8Array>) => files
) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(handler)),
      (m) => Effect.promise(() => m.close())
    )
    const baseApi = yield* client()
    const api = {
      ...baseApi,
      EnableLcm: (params: Parameters<typeof baseApi.EnableLcm>[0]) =>
        Effect.gen(function* () {
          const offer = yield* baseApi.GetLcmEnableOffer(params)
          return yield* baseApi.EnableLcm({
            ...params,
            approved:
              params.approved ?? (params.choice === "adopt" ? (offer.adopted ?? offer.fromScratch) : offer.fromScratch)
          })
        }),
      SetLcmBackfill: (params: Parameters<typeof baseApi.SetLcmBackfill>[0]) =>
        Effect.gen(function* () {
          const current = params.action === "continue" ? yield* baseApi.GetLcmBackfill(params) : null
          return yield* baseApi.SetLcmBackfill({
            ...params,
            ...(params.action === "continue" && current ? { approved: params.approved ?? current.remaining } : {})
          })
        })
    }
    const writer = yield* Writer,
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
    const model = yield* api.AddUserModel({
      connectionId: connection.id,
      key: "primary-model",
      overrides: { context: 8192, maxOutput: 512 }
    })
    yield* fixtureSql(server.config.dataDir, [
      {
        sql: "UPDATE models SET upstream_json = ? WHERE id = ?",
        params: [JSON.stringify({ price: PRICE }), model.id]
      }
    ])
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
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: preset.ref.id, judge: null, lcm: {} }
    })

    // --- Import: three chats, each with a hidden run of 20 and a summary covering it.
    const { report } = yield* importStFolder(transform(backfillFolder("ST/data/default-user/", names, folderOptions)))
    assert.strictEqual(report.hiddenRuns.length, names.length)
    const chats = yield* api.ListChats({ limit: 50, before: null })
    const chatNamed = (name: string) => chats.find((c) => c.title === name)!

    const knobs = { enabled: false, leafInput: 600, leafTarget: L1_TOKENS, fanout: 3, condenseTarget: CONDENSED_TOKENS }
    const prepare = (name: string) =>
      Effect.gen(function* () {
        const chat = chatNamed(name)
        const leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId as SlotId
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "lcm.settings", value: knobs }
        })
        return { chatId: chat.id as ChatId, leaf }
      })
    const ledger = (chatId: ChatId) =>
      Effect.map(api.ListLlmRequests({ limit: 1000, before: null }), (list) =>
        list.filter((r: LlmRequest) => r.chatId === chatId && (r.purpose === "summarize" || r.purpose === "condense"))
      )
    /** A reply's planning and the cascade it starts, run to the end (the pool is off in this test). */
    const settle = (chatId: ChatId, leafSlotId: SlotId, first: "reply" | "completion" = "reply") =>
      Effect.gen(function* () {
        let reason: "reply" | "completion" = first
        let ran = 0
        for (let pass = 0; pass < 80; pass++) {
          const made = yield* summarizer.planNow({ userId, chatId, leafSlotId }, reason)
          let done = 0
          for (;;) {
            const job = yield* writer.ClaimSummaryJob({ userId })
            if (!job) break
            yield* summarizer.runJob(job)
            done++
          }
          ran += done
          if (!made.length && !done) break
          reason = "completion"
        }
        return ran
      })
    const totals = (requests: ReadonlyArray<LlmRequest>) => ({
      uncached: requests.reduce((n, r) => n + (r.counts.inputUncached ?? 0), 0),
      cached: requests.reduce((n, r) => n + (r.counts.cacheRead ?? 0), 0),
      output: requests.reduce((n, r) => n + (r.counts.output ?? 0), 0),
      cost: requests.reduce((n, r) => n + (r.cost?.amount ?? 0), 0)
    })

    return { mock, api, writer, reader, summarizer, userId, prepare, ledger, settle, totals, config: server.config }
  })
