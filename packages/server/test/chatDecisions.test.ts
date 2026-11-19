// A chat's own Decisions setting (`decision.points`, spec/AGENTIC.md §7), against a fake
// System-One endpoint: a point a connection has on and this chat turns off asks nothing and
// sends nothing, the reply is written as with no decision model, and its request view says
// what decided instead; the switch belongs to its branch from its message on, and turning it
// back on asks again. A chat can't turn on what no connection has on.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import type { ServerResponse } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { foldState } from "@dreamspan/shared/state.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader } from "../src/db/Database.ts"
import { DecisionEngine } from "../src/decision/engine.ts"
import { Generator } from "../src/chat/Generator.ts"
import * as ContextGenerator from "../src/chat/ContextGenerator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
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

const mockWith = (decide: (request: Recorded) => unknown) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((request, res: ServerResponse) => {
        if (request.path === "/decide") return json(res, 200, decide(request))
        sse(res, completionChunks(["*Mira nods.* Go on."], { prompt_tokens: 50, completion_tokens: 4 }))
      })
    ),
    (m) => Effect.promise(() => m.close())
  )

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
    )
  ]
}

const decides = (requests: ReadonlyArray<Recorded>) => requests.filter((r) => r.path === "/decide")
const chatBodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => JSON.stringify(r.body?.messages ?? []))

const count = (dataDir: string, sql: string) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    return (db.prepare(sql).get() as { n: number }).n
  } finally {
    db.close()
  }
}

/** One reply in a chat whose lorebook entry waits for the decision model, with the chat's own off-list. */
const loreReply = (off: ReadonlyArray<string> | null, connectionOn: boolean) => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* mockWith(() => ({ answers: { e0: { noul: 0.99 } } }))
    const api = yield* client()
    if (connectionOn) yield* decisionConnection(api, mock.url, { lore: { on: true, threshold: 0.7 } })
    const { version, chat } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      lorebook: book,
      ...(off === null
        ? {}
        : {
            before: (made) =>
              Effect.asVoid(
                api.ChangeCast({
                  chatId: made.id,
                  forkId: made.currentForkId,
                  slotId: made.activeLeafSlotId,
                  change: { _tag: "DecisionPoints", off }
                })
              )
          })
    })
    const run = yield* api.GetRunContext({ versionId: version.id })
    const cast = yield* api.GetCast({ chatId: chat.id, forkId: chat.currentForkId, slotId: version.slotId })
    return {
      status: version.status,
      decides: decides(mock.requests()).length,
      bodies: chatBodies(mock.requests()),
      run,
      cast,
      decisionRollouts: count(config.dataDir, "SELECT count(*) AS n FROM rollouts WHERE kind = 'decision'")
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
}

describe("a chat's own decision switches", () => {
  it.live(
    "a decision off in the chat sends nothing, and the reply is the one a chat without a decision model gets",
    () =>
      Effect.gen(function* () {
        const asked = yield* loreReply(null, true)
        assert.strictEqual(asked.decides, 1)
        assert.include(asked.bodies.at(-1)!, "The Gull")
        assert.isUndefined(asked.run.decisionsOff)
        assert.isUndefined(asked.cast.decisionsOff)

        // "presence" is off here too, but no connection has it on: nothing was skipped for it.
        const off = yield* loreReply(["lore", "presence"], true)
        assert.strictEqual(off.status, "complete")
        assert.strictEqual(off.decides, 0)
        assert.strictEqual(off.decisionRollouts, 0)
        assert.notInclude(off.bodies.at(-1)!, "The Gull")
        assert.deepStrictEqual(off.cast.decisionsOff, ["lore", "presence"])
        assert.deepStrictEqual(off.run.decisionsOff, [
          { id: "lore", label: "Lorebook entries", instead: "Only the entries' keys decided which were included." }
        ])

        // The same chat with no decision connection at all: the same request, and nothing to say.
        const none = yield* loreReply(null, false)
        assert.strictEqual(none.decides, 0)
        assert.deepStrictEqual(off.bodies, none.bodies)
        assert.isUndefined(none.run.decisionsOff)

        // Off in a chat whose account has no decision connection: nothing is listed as skipped.
        const unused = yield* loreReply(["lore"], false)
        assert.deepStrictEqual(unused.bodies, none.bodies)
        assert.isUndefined(unused.run.decisionsOff)
      })
  )

  it.live("the switch belongs to its branch, from its message on, and turning it back on asks again", () => {
    const config = testConfig()
    const capture = engineCapture()
    return Effect.gen(function* () {
      const mock = yield* mockWith((request) => ({
        answers: Object.fromEntries(Object.keys(request.body?.questions ?? {}).map((id) => [id, { noul: 0.99 }]))
      }))
      const api = yield* client()
      const { version, chat, sent } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren"]
      })
      const userId = (yield* api.Whoami()).id
      const main = (yield* api.GetChat({ chatId: chat.id })).currentForkId
      // A branch made before the switch: it must never hear of it.
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: version.slotId })
      yield* decisionConnection(api, mock.url, { presence: { on: true, threshold: 0.85 } })
      const engine = capture.get()
      const after = (forkId: typeof main) =>
        engine.afterReply({ userId, chatId: chat.id, slotId: version.slotId, versionId: version.id, forkId })
      const change = (off: ReadonlyArray<string>) =>
        api.ChangeCast({
          chatId: chat.id,
          forkId: main,
          slotId: version.slotId,
          change: { _tag: "DecisionPoints", off }
        })

      const cast = yield* change(["presence", "presence", "not-a-point"])
      assert.deepStrictEqual(cast.decisionsOff, ["presence", "not-a-point"])
      const marks = (forkId: typeof main) =>
        api.GetStateMarks({
          chatId: chat.id,
          forkId: forkId!,
          slotId: version.slotId,
          keys: ["decision.points"]
        })
      assert.deepStrictEqual(
        (yield* marks(main)).events.map((e) => [e.slotId, e.value]),
        [[version.slotId, { off: ["presence", "not-a-point"] }]]
      )
      assert.isEmpty((yield* marks(fork.id)).events)
      yield* after(main)
      assert.strictEqual(decides(mock.requests()).length, 0)
      // Before the switch's message, on the same branch, the point still holds.
      const earlier = yield* api.GetCast({ chatId: chat.id, forkId: main, slotId: sent.slotId })
      assert.isUndefined(earlier.decisionsOff)

      // The other branch asks as the connection says.
      assert.isUndefined(
        (yield* api.GetCast({ chatId: chat.id, forkId: fork.id, slotId: version.slotId })).decisionsOff
      )
      yield* after(fork.id)
      assert.strictEqual(decides(mock.requests()).length, 1)

      // The engine itself refuses, whoever calls it: a plugin's point can't ask past the switch.
      const refused = yield* engine.evaluate(
        "presence",
        { candidates: [{ entity: "x", name: "Wren", present: true }], characters: ["Wren"], recent: [] },
        { userId, chatId: chat.id, slotId: version.slotId, forkId: main, requestClass: "background" }
      )
      assert.deepStrictEqual([refused.source, refused.reason], ["heuristic", "off_in_chat"])
      assert.strictEqual(decides(mock.requests()).length, 1)

      // Back on: an empty list leaves no trace in the state, and the point asks again.
      const cleared = yield* change([])
      assert.isUndefined(cleared.decisionsOff)
      assert.deepStrictEqual((yield* marks(main)).events.at(-1)!.value, { off: [] })
      const reader = yield* Reader
      const state = foldState(
        yield* reader.StateEventsAt({ userId, chatId: chat.id, slotId: version.slotId, forkId: main })
      )
      assert.isFalse("decisionsOff" in state)
      yield* after(main)
      assert.strictEqual(decides(mock.requests()).length, 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, capture.generator)))
  })
})
