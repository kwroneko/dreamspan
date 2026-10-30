// The request inspector and the cache-warmth estimate (ARCHITECTURE §15) over a real
// server, its workers and a socket, with a reply generated through a mock provider.
import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { CacheWarmth } from "@rp/shared/inspectorApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { presetDoc } from "./support/docs.ts"

/** Reports a cache read, so the estimate counts as verified. */
const completion = (_request: Recorded, res: Parameters<typeof sse>[0]) =>
  sse(
    res,
    completionChunks(["The ledger ", "says otherwise."], {
      prompt_tokens: 120,
      completion_tokens: 6,
      prompt_tokens_details: { cached_tokens: 100 }
    })
  )

const mockProvider = Effect.acquireRelease(
  Effect.promise(() => startMockProvider(completion)),
  (m) => Effect.promise(() => m.close())
)

/** The estimates pushed since `from` events had arrived. */
const estimates = (events: ReadonlyArray<ChatEvent>, from: number) =>
  events.slice(from).flatMap((e) => (e._tag === "Cache" ? [e.warmth] : []))

/** Waits for an estimate pushed after `from` that passes `check`. */
const estimate = (events: ReadonlyArray<ChatEvent>, from: number, check: (w: CacheWarmth | null) => boolean) =>
  Effect.map(
    eventually(() => estimates(events, from).some(check)),
    () => estimates(events, from).findLast(check)!
  )

describe("the request inspector", () => {
  it.live("shows a reply's context as sent, with its sources, breakpoints, usage and issues", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        preset: { assistant_prefill: "Hm." }
      })
      assert.strictEqual(version.status, "complete")
      const run = yield* api.GetRunContext({ versionId: version.id })
      const body = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body!
      assert.deepStrictEqual(
        run.messages.map((m) => ({ role: m.role, content: m.content })),
        body.messages
      )
      const window = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const [greeting, sent] = window.entries
      assert.deepStrictEqual(
        run.messages.map((m) => [m.sources.map((s) => s.label), m.breakpoint]),
        [
          [["Preset prompt “Main Prompt”"], null],
          [
            [
              "Persona “Tobin”: description",
              "Preset: card join prefix",
              "Preset: card join suffix",
              "Tobin's persona",
              "Personas"
            ],
            null
          ],
          [
            [
              "Card “Mira”: description",
              "Preset: card join prefix",
              "Preset: card join suffix",
              "Mira's description",
              "The characters' descriptions"
            ],
            null
          ],
          [["Preset: new chat prompt"], "prefix"],
          [["Message 1"], null],
          [["Message 2"], "history"],
          [["End of request: when a character speaks"], null]
        ]
      )
      assert.deepStrictEqual(
        run.messages.slice(4, 6).map((m) => m.sources[0]!.slotId),
        [greeting!.slotId, sent!.slotId]
      )
      assert.strictEqual(run.messages[5]!.tokens, Math.ceil("The road flooded.".length / 4) + 3)
      assert.deepStrictEqual(run.model, {
        connection: "Mock",
        model: "mock-model",
        kind: "openai-chat",
        breakpoints: "auto"
      })
      assert.deepStrictEqual(
        run.requests.map((r) => [r.status, r.counts.cacheRead, r.counts.output]),
        [["complete", 100, 6]]
      )
      assert.strictEqual(run.status, "completed")
      // The issue the context recorded shows on the version and in the inspector.
      assert.deepStrictEqual(
        run.issues.map((i) => i.kind),
        ["prefill_dropped"]
      )
      const reply = window.entries.find((e) => e.version.id === version.id)!
      assert.deepStrictEqual(reply.version.context, { issues: run.issues })
      assert.deepStrictEqual(version.context, { issues: run.issues })
      // Nothing generated the greeting or the user's message.
      assert.isNull(greeting!.version.context)
      const missing = yield* Effect.flip(api.GetRunContext({ versionId: sent!.version.id }))
      assert.strictEqual(missing._tag, "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("the cache-warmth estimate", () => {
  it.live("is warm after a reply, and cold once a message above the breakpoint is edited", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
        model: {}
      })
      const ended = events.findIndex((e) => e._tag === "Version" && e.version.id === version.id)
      const warm = yield* estimate(events, ended, (w) => w !== null)
      const request = (yield* api.ListLlmRequests({ limit: 10, before: null }))[0]!
      assert.deepStrictEqual(warm, {
        lastRequestAt: request.startedAt,
        ttlS: 300,
        expiresAt: request.startedAt + 300_000,
        verified: true,
        prefixTokens: warm!.prefixTokens,
        changed: null
      })
      assert.isAbove(warm!.prefixTokens, 0)

      const window = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const sent = window.entries[1]!
      const before = events.length
      yield* api.EditVersion({
        slotId: sent.slotId,
        sourceVersionId: sent.version.id,
        content: "The road washed out.",
        expectedRowVersion: sent.rowVersion
      })
      const cold = yield* estimate(events, before, (w) => w?.changed != null)
      assert.strictEqual(cold!.changed!.reason, "Message 2 was edited, or another of its versions chosen.")
      assert.strictEqual(
        cold!.changed!.tokens,
        Math.ceil("The road washed out.".length / 4) + 3 + Math.ceil(version.content.length / 4) + 3
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("names a message inserted above the breakpoint, and replays the earlier capture unchanged", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
        model: {}
      })
      const userId = (yield* api.Whoami()).id
      const forkId = chat.currentForkId!
      const ended = events.findIndex((e) => e._tag === "Version" && e.version.id === version.id)
      yield* estimate(events, ended, (w) => w !== null && w.changed === null)
      const run = yield* api.GetRunContext({ versionId: version.id })
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: `SELECT p.context_snapshot_json AS snapshot FROM rollout_payloads p
              JOIN versions v ON v.rollout_id = p.rollout_id WHERE v.id = ?`,
            params: [version.id]
          }
        ],
        { readOnly: true }
      )
      const snapshot = rows![0]!.snapshot as string
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot })
      const [greeting] = (yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })).entries
      yield* writer.InsertMessage({
        userId,
        chatId: chat.id,
        forkId,
        anchorSlotId: greeting!.slotId,
        expectedRowVersion: greeting!.rowVersion,
        body: { _tag: "Write", speaker: null, content: "A lantern swings by the door." }
      })
      const warmth = yield* reader.CacheWarmth({ userId, chatId: chat.id, leafSlotId: null, forkId })
      // The inserted message is the second shown, so the first change of the next request.
      assert.strictEqual(warmth.warmth!.changed!.reason, "Message 2 was inserted.")
      assert.isAbove(warmth.warmth!.changed!.tokens, Math.ceil("A lantern swings by the door.".length / 4))
      // The capture of the earlier reply, and its replay, don't change.
      assert.deepStrictEqual(yield* api.GetRunContext({ versionId: version.id }), run)
      assert.deepStrictEqual(yield* reader.RebuildContext({ userId, snapshot }), rebuilt)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("is cold on another branch", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
        model: {}
      })
      const ended = events.findIndex((e) => e._tag === "Version" && e.version.id === version.id)
      yield* estimate(events, ended, (w) => w !== null && w.changed === null)
      const before = events.length
      // A message under the greeting starts another branch, which becomes the chat's.
      yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: true, content: "Again." })
      )
      const cold = yield* estimate(events, before, (w) => w?.changed != null)
      assert.strictEqual(cold!.changed!.reason, "The path changed: another branch is shown, or Message 2 was deleted.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("says the preset changed, when the user's default preset does", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version, events, connection, model } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
        model: {}
      })
      const ended = events.findIndex((e) => e._tag === "Version" && e.version.id === version.id)
      yield* estimate(events, ended, (w) => w !== null && w.changed === null)
      // Estimates the chat's own changes asked for are done: only the new default can ask for the next.
      yield* Effect.sleep("1 second")
      const me = yield* api.Whoami()
      const other = yield* (yield* Writer).CreateEntity({
        userId: me.id,
        kind: "preset",
        label: "Other",
        subtitle: "",
        doc: presetDoc([{ identifier: "main", content: "Write tersely." }]),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const before = events.length
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: other.ref.id }
      })
      const cold = yield* estimate(events, before, (w) => w?.changed != null)
      assert.strictEqual(cold!.changed!.reason, "The preset changed.")
      assert.isAbove(cold!.changed!.tokens, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("isn't given for a model without a cache TTL", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const ended = events.findIndex((e) => e._tag === "Version" && e.version.id === version.id)
      yield* eventually(() => estimates(events, ended).length > 0)
      assert.isTrue(estimates(events, 0).every((w) => w === null))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
