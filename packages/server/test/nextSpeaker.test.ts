// "Who replies next" (the `next` decision point; DESIGN §2.3, spec/AGENTIC.md §7) against a fake
// System-One endpoint: the model's pick becomes the speaker of a reply Auto picked, recorded on the
// version and shown by the inspector; its candidates are the present characters the user doesn't
// play, but whoever spoke last; below the threshold, on a malformed answer, an error or a timeout,
// Auto's pick stays; and nothing is sent unless the point is on for a connection with a model, or
// for a reply someone chose the speaker of. A round asks again at each of its replies.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import { DatabaseSync } from "node:sqlite"
import type { Chat } from "@dreamspan/shared/chat.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Writer } from "../src/db/Database.ts"
import { NEXT_TIMEOUT_MS } from "../src/decision/points/next.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { completionChunks, json, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** The chat model streams a reply; the decision endpoint answers what `decide` says (undefined: never). */
const mockWith = (decide: (request: Recorded, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((request, res) => {
        if (request.path === "/decide") return decide(request, res)
        sse(res, completionChunks(["*nods* Go on."], { prompt_tokens: 50, completion_tokens: 4 }))
      })
    ),
    (m) => Effect.promise(() => m.close())
  )

/** A choice answer for the `next` question. */
const choose = (choice: string, p: number) => (_: Recorded, res: ServerResponse) =>
  json(res, 200, {
    model: "typesafe/jev-1.13-20260917",
    answers: { next: { choice, probabilities: { [choice]: p }, confidence: p } },
    usage: { input_tokens: 300, output_tokens: 1, cost: 0.000012 }
  })

const decisionConnection = (
  api: Api,
  url: string,
  points: Record<string, { on: boolean; threshold: number }>,
  withModel = true
) =>
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
    yield* api.SetDecisionSettings({ connectionId: connection.id, model: withModel ? model.id : null, points })
  })

const decides = (requests: ReadonlyArray<Recorded>) => requests.filter((r) => r.path === "/decide")

const rows = <T>(dataDir: string, sql: string, ...params: Array<string>) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    return db.prepare(sql).all(...params) as Array<T>
  } finally {
    db.close()
  }
}

const ON = { next: { on: true, threshold: 0.5 } }

/** The chat's other three characters: Mira (Auto's pick), Wren and Ash; the user plays Tobin. */
const GROUP = ["Wren", "Ash"]

describe("who replies next", () => {
  it.live("the model's pick writes the reply, recorded on it, in Activity and in the inspector", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(choose("c1", 0.91))
      const api = yield* client()
      const { version, characters } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: GROUP,
        auto: { speaker: "Mira" },
        before: () => decisionConnection(api, mock.url, ON)
      })
      const wren = characters[0]!.entityId
      const [asked] = decides(mock.requests())
      // Auto's pick first, then the others present; the question names each.
      const body = asked!.body as {
        state: { characters: Array<string>; last_speaker: string; recent: Array<{ from: string }> }
        questions: { next: { type: string; criteria: Record<string, string> } }
      }
      assert.deepStrictEqual(body.state.characters, ["Mira", "Wren", "Ash"])
      assert.strictEqual(body.state.last_speaker, "User")
      assert.deepStrictEqual(
        body.state.recent.map((m) => m.from),
        ["Mira", "User"]
      )
      assert.strictEqual(body.questions.next.type, "choice")
      assert.deepStrictEqual(Object.values(body.questions.next.criteria), [
        "Mira speaks next.",
        "Wren speaks next.",
        "Ash speaks next."
      ])
      assert.strictEqual(version.speakerEntityId, wren)
      assert.deepInclude(version.speakerPick as object, { by: "decision", name: "Wren", confidence: 0.91 })
      // The reply is written as Wren.
      const sent = JSON.stringify(mock.requests().find((r) => r.path === "/v1/chat/completions")?.body ?? {})
      assert.include(sent, "Wren rides with Tobin")
      const [decision] = rows<{ status: string; usage_cost: number }>(
        config.dataDir,
        "SELECT status, usage_cost FROM rollouts WHERE kind = 'decision'"
      )
      assert.deepStrictEqual(decision, { status: "completed", usage_cost: 0.000012 })
      const run = yield* api.GetRunContext({ versionId: version.id })
      assert.deepStrictEqual(run.speakerPick, { name: "Wren", confidence: 0.91 })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("candidates: away, muted and played characters, and the last speaker, aren't asked about", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(choose("c0", 0.9))
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren", "Ash", "Quill"],
        muted: ["Ash"],
        auto: { speaker: "Wren" },
        before: (chat: Chat, [, , quill]) =>
          Effect.gen(function* () {
            yield* decisionConnection(api, mock.url, ON)
            // Quill left the scene, as the presence point marks it.
            const userId = (yield* api.Whoami()).id
            yield* (yield* Writer).AddStateEvent({
              userId,
              chatId: chat.id,
              slotId: null,
              versionId: null,
              scope: null,
              data: { key: "away.set", value: { entity: quill!, away: true, source: "decision" } }
            })
          })
      })
      const body = decides(mock.requests())[0]!.body as { state: { characters: Array<string> } }
      assert.deepStrictEqual(body.state.characters, ["Wren", "Mira"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("with one character to choose, nothing is asked", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(choose("c0", 0.9))
      const api = yield* client()
      const { version, mira } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: ["Wren"],
        muted: ["Wren"],
        auto: { speaker: "Mira" },
        before: () => decisionConnection(api, mock.url, ON)
      })
      assert.deepStrictEqual(decides(mock.requests()), [])
      assert.strictEqual(version.speakerEntityId, mira.entityId)
      assert.deepStrictEqual(version.speakerPick, { by: "order" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const [name, answer] of [
    ["below the threshold", choose("c1", 0.3)],
    ["a malformed answer", choose("c9", 0.99)],
    ["an error", (_: Recorded, res: ServerResponse) => json(res, 500, { error: "overloaded" })]
  ] as const)
    it.live(`fallback: ${name} keeps Auto's pick`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* mockWith(answer)
        const api = yield* client()
        const { version, mira } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          characters: GROUP,
          auto: { speaker: "Mira" },
          before: () => decisionConnection(api, mock.url, { next: { on: true, threshold: 0.6 } })
        })
        assert.lengthOf(decides(mock.requests()), 1)
        assert.strictEqual(version.speakerEntityId, mira.entityId)
        assert.deepStrictEqual(version.speakerPick, { by: "order" })
        assert.strictEqual(version.status, "complete")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live(
    "fallback: no answer within the deadline keeps Auto's pick",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const pending: Array<ServerResponse> = []
        const mock = yield* mockWith((_, res) => void pending.push(res))
        const api = yield* client()
        const started = Date.now()
        const { version, mira } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          characters: GROUP,
          auto: { speaker: "Mira" },
          before: () => decisionConnection(api, mock.url, ON)
        })
        assert.isAtLeast(Date.now() - started, NEXT_TIMEOUT_MS)
        assert.strictEqual(version.speakerEntityId, mira.entityId)
        const [decision] = rows<{ status: string }>(
          config.dataDir,
          "SELECT status FROM rollouts WHERE kind = 'decision'"
        )
        assert.strictEqual(decision!.status, "failed")
        for (const res of pending) res.destroy()
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    20_000
  )

  for (const [name, setup] of [
    [
      "the point is off",
      (api: Api, url: string) => decisionConnection(api, url, { next: { on: false, threshold: 0.5 } })
    ],
    ["no decision model is chosen", (api: Api, url: string) => decisionConnection(api, url, ON, false)],
    ["no decision connection exists", () => Effect.void]
  ] as const)
    it.live(`consent: nothing is sent when ${name}`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* mockWith(choose("c1", 0.99))
        const api = yield* client()
        const { version, mira } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          characters: GROUP,
          auto: { speaker: "Mira" },
          before: () => setup(api, mock.url)
        })
        assert.deepStrictEqual(decides(mock.requests()), [])
        assert.deepStrictEqual(rows(config.dataDir, "SELECT id FROM rollouts WHERE kind = 'decision'"), [])
        assert.strictEqual(version.speakerEntityId, mira.entityId)
        // Not left waiting for a choice: Auto's pick stands, and the reply shows it.
        assert.deepStrictEqual(version.speakerPick, { by: "order" })
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("a speaker someone chose is never asked about", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockWith(choose("c1", 0.99))
      const api = yield* client()
      // Generate with no Auto flag: a pick under Next, ▶ on a card, Speak now.
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: GROUP,
        before: () => decisionConnection(api, mock.url, ON)
      })
      assert.deepStrictEqual(decides(mock.requests()), [])
      assert.isUndefined(version.speakerPick)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a round asks again at each reply, without the one who just spoke", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // The first reply: Wren (c1 of Mira, Wren, Ash); the round's next: Mira (c1 of Ash, Mira).
      const mock = yield* mockWith(choose("c1", 0.9))
      const api = yield* client()
      const { events, characters, mira } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        characters: GROUP,
        auto: { speaker: "Mira", round: ["Ash"] },
        before: () => decisionConnection(api, mock.url, ON)
      })
      const done = () =>
        events.flatMap((e) =>
          e._tag === "Version" && e.version.status === "complete" && e.version.writer === "model" ? [e.version] : []
        )
      yield* eventually(() => done().length >= 2)
      // The round's later turn says the decision model chooses it, and where the round started.
      const queued = events.flatMap((e) => (e._tag === "Queue" ? e.queue : [])).filter((q) => q.round)
      assert.isNotEmpty(queued)
      for (const entry of queued) {
        assert.isTrue(entry.round!.decides)
        assert.strictEqual(entry.round!.startSlotId, done()[0]!.slotId)
      }
      // Every reply of the round shows the speaker chosen, none left waiting.
      assert.deepStrictEqual(
        done().map((v) => v.speakerPick?.by),
        ["decision", "decision"]
      )
      const asked = decides(mock.requests()).map((r) => (r.body as { state: { characters: Array<string> } }).state)
      assert.deepStrictEqual(
        asked.map((s) => s.characters),
        [
          ["Mira", "Wren", "Ash"],
          ["Ash", "Mira"]
        ]
      )
      assert.deepStrictEqual(
        done().map((v) => v.speakerEntityId),
        [characters[0]!.entityId, mira.entityId]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
