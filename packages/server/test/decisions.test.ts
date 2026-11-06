// Decision models (spec/AGENTIC.md §7) end to end, against a fake System-One endpoint: a point
// that isn't on sends nothing; the `lore` point admits an entry the keys left out, frozen in the
// reply's snapshot; a malformed answer is billed and falls back; the `presence` point marks a
// character away on the reply's version, never overriding the user's own Mute. Each call is a
// rollout of kind `decision` with its ledger rows rolled up, for the Activity panel.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option } from "effect"
import type { ServerResponse } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { type EntityId, NewVersion } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { foldState } from "@rp/shared/state.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { DecisionEngine } from "../src/decision/engine.ts"
import { Generator } from "../src/chat/Generator.ts"
import * as ContextGenerator from "../src/chat/ContextGenerator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { loreEntry } from "./support/loreFixtures.ts"
import { completionChunks, json, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const engineCapture = () => {
  let engine: DecisionEngine["Service"]
  const generator = Layer.effect(
    Generator,
    Effect.gen(function* () {
      engine = Option.getOrThrow(yield* Effect.serviceOption(DecisionEngine))
      return yield* Generator
    })
  ).pipe(Layer.provide(ContextGenerator.layer))
  return { generator, get: () => engine }
}

/** The chat model streams a reply; the decision endpoint answers what `decide` says. */
const mockWith = (decide: (request: Recorded) => unknown, reply = "*Mira nods.* Go on.") =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((request, res: ServerResponse) => {
        if (request.path === "/decide") return json(res, 200, decide(request))
        sse(res, completionChunks([reply], { prompt_tokens: 50, completion_tokens: 4 }))
      })
    ),
    (m) => Effect.promise(() => m.close())
  )

/** A System-One connection with its model, and the points given turned on for it. */
const decisionConnection = (api: Api, url: string, points: Record<string, { on: boolean; threshold: number }>) =>
  Effect.gen(function* () {
    const connection = yield* api.CreateConnection({
      kind: "system-one",
      settings: {
        name: "Jev",
        baseUrl: `${url}/decide`,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-decide-0123456789"
    })
    const model = yield* api.AddUserModel({ connectionId: connection.id, key: "typesafe/jev-1.13", overrides: {} })
    yield* api.SetDecisionSettings({ connectionId: connection.id, model: model.id, points })
    return { connection, model }
  })

const book = {
  schema_version: 1 as const,
  name: "World",
  description: "",
  scan_depth: null,
  token_budget: null,
  recursive_scanning: null,
  extensions: {},
  entries: [
    loreEntry(
      {
        keys: ["zeppelin"],
        comment: "The airship",
        content: "The Gull, an airship, hangs over the harbour.",
        decision_hint: "The airship is near the characters in the latest messages."
      },
      0
    ),
    loreEntry({ keys: ["glacier"], comment: "Ice", content: "Ice fields lie north." }, 1)
  ]
}

const sentText = (requests: ReadonlyArray<Recorded>) =>
  JSON.stringify(requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body?.messages ?? [])

const rows = <T>(dataDir: string, sql: string, ...params: Array<string>) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    return db.prepare(sql).all(...params) as Array<T>
  } finally {
    db.close()
  }
}

describe("decision models", () => {
  it.live("lore: an answer for an earlier entry revision cannot admit its replacement", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let pending: ServerResponse | undefined
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            if (request.path === "/decide") {
              pending = res
              return
            }
            sse(res, completionChunks(["A reply."], { prompt_tokens: 10, completion_tokens: 2 }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* decisionConnection(api, mock.url, { lore: { on: true, threshold: 0.7 } })
      const fiber = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        lorebook: book
      }).pipe(Effect.forkScoped)
      yield* eventually(() => pending !== undefined)
      const userId = (yield* api.Whoami()).id
      const [chat] = yield* api.ListChats({ limit: 10, before: null })
      const reader = yield* Reader
      const writer = yield* Writer
      const state = foldState(yield* reader.StateEventsAt({ userId, chatId: chat!.id, slotId: null }))
      const { ref } = yield* reader.GetRef({ userId, refId: state.lorebooks[0]! as RefId })
      yield* writer.EditRef({
        userId,
        refId: ref.id,
        expectedRowVersion: ref.rowVersion,
        doc: {
          ...book,
          entries: [
            { ...book.entries[0]!, decision_hint: "A glacier surrounds the characters.", content: "REPLACEMENT LORE" }
          ]
        },
        message: null,
        commitDraft: null
      })
      json(pending!, 200, { answers: { e0: { noul: 0.99 } } })
      const { version } = yield* Fiber.join(fiber)
      assert.strictEqual(version.status, "complete")
      assert.notInclude(sentText(mock.requests()), "REPLACEMENT LORE")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("disabling the registered lore point preserves keyword-only replies", () => {
    const config = testConfig()
    const capture = engineCapture()
    return Effect.gen(function* () {
      const mock = yield* mockWith(() => ({ answers: { e0: { noul: 0.99 } } }))
      const api = yield* client()
      yield* decisionConnection(api, mock.url, { lore: { on: true, threshold: 0.7 } })
      const engine = capture.get()
      yield* engine.points.disable("lore")
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        lorebook: book
      })
      assert.strictEqual(version.status, "complete")
      assert.notInclude(sentText(mock.requests()), "The Gull")
      assert.deepStrictEqual(
        mock.requests().filter((r) => r.path === "/decide"),
        []
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, capture.generator)))
  })

  for (const [name, fields, budget] of [
    ["message delay", { delay: 100 }, null],
    ["trigger", { triggers: ["continue"] }, null],
    ["probability", { probability: 0 }, null],
    ["book budget", {}, 1]
  ] as const)
    it.live(`lore: a model admission respects the entry's ${name}`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* mockWith((request) => ({
          answers: Object.fromEntries(Object.keys(request.body?.questions ?? {}).map((id) => [id, { noul: 0.99 }]))
        }))
        const api = yield* client()
        yield* decisionConnection(api, mock.url, { lore: { on: true, threshold: 0.7 } })
        const { version } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          lorebook: { ...book, token_budget: budget, entries: [{ ...book.entries[0]!, ...fields }] }
        })
        assert.strictEqual(version.status, "complete")
        assert.notInclude(sentText(mock.requests()), "The Gull")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("presence: an old reply cannot judge the selected alternative's text", () => {
    const config = testConfig()
    const capture = engineCapture()
    return Effect.gen(function* () {
      const mock = yield* mockWith(() => ({ answers: { c0: { noul: 0.99 }, c1: { noul: 0.01 } } }))
      const api = yield* client()
      const { version, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren"]
      })
      const userId = (yield* api.Whoami()).id
      const writer = yield* Writer
      yield* writer.AddVersion({
        userId,
        slotId: version.slotId,
        forkId: chat.currentForkId!,
        select: true,
        commitDraft: null,
        version: new NewVersion({
          content: "An unrelated alternative.",
          speakerEntityId: null,
          writer: "human",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      yield* decisionConnection(api, mock.url, { presence: { on: true, threshold: 0.85 } })
      const engine = capture.get()
      assert.isFalse(
        yield* engine.afterReply({
          userId,
          chatId: chat.id,
          slotId: version.slotId,
          versionId: version.id,
          forkId: chat.currentForkId
        })
      )
      assert.deepStrictEqual(
        mock.requests().filter((r) => r.path === "/decide"),
        []
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, capture.generator)))
  })

  it.live("presence: a manual mute made while the model answers stays in force", () => {
    const config = testConfig()
    const capture = engineCapture()
    return Effect.gen(function* () {
      let pending: ServerResponse | undefined
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            if (request.path === "/decide") {
              pending = res
              return
            }
            sse(res, completionChunks(["Wren returns."], { prompt_tokens: 10, completion_tokens: 2 }))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, characters } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren"]
      })
      const userId = (yield* api.Whoami()).id
      const writer = yield* Writer
      const entity = characters[0]!.entityId
      const mute = (source?: "decision") =>
        writer.AddStateEvent({
          userId,
          chatId: chat.id,
          slotId: version.slotId,
          forkId: chat.currentForkId,
          versionId: null,
          scope: null,
          data: { key: "presence.set", value: { entity, present: false, ...(source ? { source } : {}) } }
        })
      yield* mute("decision")
      yield* decisionConnection(api, mock.url, { presence: { on: true, threshold: 0.85 } })
      const engine = capture.get()
      const fiber = yield* engine
        .afterReply({
          userId,
          chatId: chat.id,
          slotId: version.slotId,
          versionId: version.id,
          forkId: chat.currentForkId
        })
        .pipe(Effect.forkScoped)
      yield* eventually(() => pending !== undefined)
      yield* mute()
      json(pending!, 200, { answers: { c0: { noul: 0.99 }, c1: { noul: 0.99 } } })
      yield* Fiber.join(fiber)
      const reader = yield* Reader
      const events = yield* reader.StateEventsAt({
        userId,
        chatId: chat.id,
        slotId: version.slotId,
        forkId: chat.currentForkId
      })
      assert.include(foldState(events).absent, entity)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, capture.generator)))
  })

  it.live("a point that isn't on for any connection sends nothing", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(() => ({ answers: {} }))
      const api = yield* client()
      // A decision connection with its model, but no point on: one switched off, one never set.
      yield* decisionConnection(api, mock.url, { lore: { on: false, threshold: 0.7 } })
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren"],
        lorebook: book
      })
      assert.strictEqual(version.status, "complete")
      // Give a background point the time it would take.
      yield* Effect.sleep(300)
      assert.deepStrictEqual(
        mock.requests().filter((r) => r.path === "/decide"),
        []
      )
      assert.notInclude(sentText(mock.requests()), "The Gull")
      assert.deepStrictEqual(rows(config.dataDir, "SELECT id FROM rollouts WHERE kind = 'decision'"), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a decision connection writes no replies: refused before anything is sent", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(() => ({ answers: {} }))
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "system-one", baseUrl: `${mock.url}/decide` },
        model: {}
      })
      assert.strictEqual(version.status, "failed")
      assert.deepStrictEqual(mock.requests(), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("lore: a yes admits the entry the keys left out, frozen in the snapshot, with its cost", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(() => ({
        model: "typesafe/jev-1.13-20260917",
        answers: { e0: { noul: 0.93 } },
        usage: { input_tokens: 120, output_tokens: 3, cost: 0.00000504 }
      }))
      const api = yield* client()
      yield* decisionConnection(api, mock.url, { lore: { on: true, threshold: 0.7 } })
      const { version, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        lorebook: book
      })
      assert.strictEqual(version.status, "complete")
      const decided = mock.requests().filter((r) => r.path === "/decide")
      assert.strictEqual(decided.length, 1)
      const body = decided[0]!.body as {
        model: string
        state: { recent: Array<{ from: string; text: string }> }
        questions: Record<string, { type: string; instructions: string }>
      }
      assert.strictEqual(decided[0]!.headers.authorization, "Bearer sk-decide-0123456789")
      assert.strictEqual(body.model, "typesafe/jev-1.13")
      // Only the entry with a question; the other is left to its keys.
      assert.deepStrictEqual(Object.keys(body.questions), ["e0"])
      assert.deepInclude(body.questions["e0"], {
        type: "noul",
        instructions: "The airship is near the characters in the latest messages."
      })
      assert.include(body.state.recent.at(-1)!.text, "The road flooded.")
      // Admitted: sent with the reply, and frozen with it.
      assert.include(sentText(mock.requests()), "The Gull, an airship, hangs over the harbour.")
      assert.notInclude(sentText(mock.requests()), "Ice fields")
      const [snapshot] = rows<{ context_snapshot_json: string }>(
        config.dataDir,
        `SELECT p.context_snapshot_json FROM rollout_payloads p JOIN versions v ON v.rollout_id = p.rollout_id
         WHERE v.id = ?`,
        version.id
      )
      const frozen = JSON.parse(snapshot!.context_snapshot_json) as {
        decisionAssembly?: unknown
        loreDecision?: unknown
        request?: unknown
      }
      const admitted = (frozen.decisionAssembly as { lore: Array<{ entry: string; probability: number }> }).lore
      assert.strictEqual(admitted.length, 1)
      assert.match(admitted[0]!.entry, /:0$/)
      assert.strictEqual(admitted[0]!.probability, 0.93)
      assert.isUndefined(frozen.loreDecision)
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: snapshot!.context_snapshot_json })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot).request, frozen.request)
      assert.strictEqual(mock.requests().filter((r) => r.path === "/decide").length, 1)
      // The inspector says why it went in.
      const context = yield* api.GetRunContext({ versionId: version.id })
      assert.isTrue(
        JSON.stringify(context).includes('"why":{"kind":"decision","probability":0.93}'),
        "the entry's activation names the decision"
      )
      // A rollout that produced no message, with the ledger's tokens and cost on it.
      const [decision] = rows<{
        id: string
        status: string
        chat_id: string
        usage_input_tokens: number
        usage_output_tokens: number
        usage_cost: number
        llm_requests: number
        transcript_json: string
      }>(
        config.dataDir,
        `SELECT r.id, r.status, r.chat_id, r.usage_input_tokens, r.usage_output_tokens, r.usage_cost, r.llm_requests,
           p.transcript_json
         FROM rollouts r JOIN rollout_payloads p ON p.rollout_id = r.id WHERE r.kind = 'decision'`
      )
      assert.deepInclude(decision, {
        status: "completed",
        chat_id: chat.id,
        usage_input_tokens: 120,
        usage_output_tokens: 3,
        usage_cost: 0.00000504,
        llm_requests: 1
      })
      assert.deepInclude(JSON.parse(decision!.transcript_json), {
        source: "model",
        servedModel: "typesafe/jev-1.13-20260917"
      })
      const [ledger] = rows<{ purpose: string; status: string; response_model: string }>(
        config.dataDir,
        "SELECT purpose, status, response_model FROM llm_requests WHERE rollout_id = ?",
        decision!.id
      )
      assert.deepStrictEqual(
        { ...ledger },
        {
          purpose: "decision",
          status: "complete",
          response_model: "typesafe/jev-1.13-20260917"
        }
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("lore: a malformed answer is billed, and the keys alone decide", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(() => ({
        answers: { e0: { noul: 1.4 } },
        usage: { input_tokens: 90, output_tokens: 1, cost: 0.000004 }
      }))
      const api = yield* client()
      yield* decisionConnection(api, mock.url, { lore: { on: true, threshold: 0.7 } })
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        lorebook: book
      })
      assert.strictEqual(version.status, "complete")
      assert.notInclude(sentText(mock.requests()), "The Gull")
      const [decision] = rows<{ status: string; error: string; usage_cost: number }>(
        config.dataDir,
        "SELECT status, error, usage_cost FROM rollouts WHERE kind = 'decision'"
      )
      assert.deepStrictEqual(
        { ...decision },
        { status: "failed", error: "The decision model's answer didn't fit the questions.", usage_cost: 0.000004 }
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("presence: a character the model is sure left is away on the reply's version; a user's Mute stays", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith((request) => {
        const questions = (request.body?.questions ?? {}) as Record<string, { instructions: string }>
        // Wren left; everyone else asked about is still there.
        return {
          answers: Object.fromEntries(
            Object.entries(questions).map(([id, q]) => [id, { noul: q.instructions.startsWith("Wren") ? 0.04 : 0.95 }])
          ),
          usage: { input_tokens: 60, output_tokens: 2 }
        }
      }, "*Wren slips out to the stables.* Mira stays by the fire.")
      const api = yield* client()
      yield* decisionConnection(api, mock.url, { presence: { on: true, threshold: 0.85 } })
      const { version, chat, characters } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren", "Ansel"],
        muted: ["Ansel"]
      })
      const [wren, ansel] = [characters[0]!, characters[1]!]
      const me = yield* api.Whoami()
      const reader = yield* Reader
      const absentAt = Effect.map(
        reader.StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId }),
        (e) => foldState(e).absent
      )
      yield* eventually(() => mock.requests().some((r) => r.path === "/decide"))
      const asked = mock.requests().find((r) => r.path === "/decide")!.body as {
        state: { characters: Array<string>; recent: Array<{ from: string; text: string }> }
        questions: Record<string, { instructions: string }>
      }
      assert.deepStrictEqual(asked.state.characters, ["Mira", "Wren", "Ansel"])
      assert.strictEqual(asked.state.recent.length, 2)
      assert.include(asked.state.recent[1]!.text, "Wren slips out")
      // Ansel was muted by the user: not asked about, and still muted after.
      assert.deepStrictEqual(
        Object.values(asked.questions).map((q) => q.instructions.split(" ")[0]),
        ["Mira", "Wren"]
      )
      let absent: ReadonlyArray<string> = []
      for (let i = 0; i < 100 && absent.length < 2; i++) {
        absent = yield* absentAt
        if (absent.length < 2) yield* Effect.sleep(50)
      }
      assert.deepStrictEqual(absent, [ansel.entityId, wren.entityId])
      const events = yield* reader.StateEventsAt({ userId: me.id, chatId: chat.id, slotId: version.slotId })
      assert.deepInclude(
        events.map((e) => e.data),
        { key: "presence.set", value: { entity: wren.entityId as EntityId, present: false, source: "decision" } }
      )
      const [decision] = rows<{ status: string; slot_id: string }>(
        config.dataDir,
        "SELECT status, slot_id FROM rollouts WHERE kind = 'decision'"
      )
      assert.deepStrictEqual({ ...decision }, { status: "completed", slot_id: version.slotId })
      const sourceFork = chat.currentForkId!
      const { fork: peer } = yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: sourceFork,
        atSlotId: version.slotId
      })
      const writer = yield* Writer
      const alternative = yield* writer.AddVersion({
        userId: me.id,
        slotId: version.slotId,
        forkId: sourceFork,
        select: true,
        commitDraft: null,
        version: new NewVersion({
          content: "Everyone stays.",
          speakerEntityId: null,
          writer: "human",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const absentIn = (forkId: typeof sourceFork) =>
        reader
          .StateEventsAt({
            userId: me.id,
            chatId: chat.id,
            slotId: version.slotId,
            forkId
          })
          .pipe(Effect.map((events) => foldState(events).absent))
      assert.deepStrictEqual(yield* absentIn(sourceFork), [ansel.entityId])
      assert.deepStrictEqual(yield* absentIn(peer.id), [ansel.entityId, wren.entityId])
      yield* api.SelectVersion({
        slotId: version.slotId,
        versionId: version.id,
        expectedVersionId: alternative.id,
        forkId: sourceFork
      })
      assert.deepStrictEqual(yield* absentIn(sourceFork), [ansel.entityId, wren.entityId])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
