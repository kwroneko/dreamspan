// Per-model reply behaviour (spec/REPLY-CONTRACT.md milestone 4): each story reply under the send
// tool records its outcome when its run ends, and Settings → Models sums them per model; a reply
// carried on with Resume counts once, as the run that carried it on ended. Scripted providers only.
import { assert, describe, it } from "@effect/vitest"
import type { ServerResponse } from "node:http"
import type { PathEntry, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"

const sendCall = (message: string) => [
  {
    id: "c",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "send_message", arguments: JSON.stringify({ message }) }
            }
          ]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "c",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

const TOOLS_ON = [
  { key: "agent.enabled", value: { on: true } },
  { key: "agent.tools", value: { tools: [] } }
] as const

const mock = (answer: (res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((req, res) =>
        req.path === "/v1/chat/completions" ? answer(res) : json(res, 404, { error: { message: "no" } })
      )
    ),
    (m) => Effect.promise(() => m.close())
  )

const resume = (api: Effect.Success<ReturnType<typeof client>>, versionId: VersionId, slotId: PathEntry["slotId"]) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
    return yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
  })

describe("per-model reply behaviour", () => {
  it.live("a clean send, an exhausted reply, and the same reply resumed: counted once, as it ended", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const sender = yield* mock((res) => sse(res, sendCall("Hello.")))
      const clean = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${sender.url}/v1` },
        model: {},
        modelKey: "sender-model",
        state: TOOLS_ON
      })
      assert.strictEqual(clean.version.status, "complete")
      let sends = false
      const writer = yield* mock((res) =>
        sends
          ? sse(res, sendCall("At last."))
          : sse(res, completionChunks(["Just text."], { prompt_tokens: 9, completion_tokens: 2 }))
      )
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${writer.url}/v1` },
        model: {},
        modelKey: "writer-model",
        state: TOOLS_ON
      })
      assert.strictEqual(version.error?.class, "contract")
      const byKey = (rows: Effect.Success<ReturnType<typeof api.GetModelBehaviour>>) =>
        Object.fromEntries(
          rows.map(({ modelKey, replies, nudged, recovered, gaveUp, exhausted, nudges }) => [
            modelKey,
            { replies, nudged, recovered, gaveUp, exhausted, nudges }
          ])
        )
      assert.deepStrictEqual(byKey(yield* api.GetModelBehaviour()), {
        "sender-model": { replies: 1, nudged: 0, recovered: 0, gaveUp: 0, exhausted: 0, nudges: 0 },
        "writer-model": { replies: 1, nudged: 1, recovered: 0, gaveUp: 0, exhausted: 1, nudges: 3 }
      })
      sends = true
      const entry = yield* resume(api, version.id, version.slotId)
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      assert.strictEqual(finished(events, entry.version.id)?.content, "At last.")
      assert.deepStrictEqual(byKey(yield* api.GetModelBehaviour())["writer-model"], {
        replies: 1,
        nudged: 1,
        recovered: 1,
        gaveUp: 0,
        exhausted: 0,
        nudges: 3
      })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  const outcomes = (api: Effect.Success<ReturnType<typeof client>>) =>
    api
      .GetModelBehaviour()
      .pipe(
        Effect.map((rows) =>
          Object.fromEntries(
            rows.map(({ modelKey, replies, recovered, exhausted, stopped, failed, capped }) => [
              modelKey,
              { replies, recovered, exhausted, stopped, failed, capped }
            ])
          )
        )
      )
  const none = { recovered: 0, exhausted: 0, stopped: 0, failed: 0, capped: 0 }
  /** The model's counts once they read `expected` (a run's record is written as its run ends). */
  const counted = (api: Effect.Success<ReturnType<typeof client>>, expected: object) =>
    Effect.gen(function* () {
      const deadline = Date.now() + 10_000
      let got = (yield* outcomes(api))["writer-model"]
      while (JSON.stringify(got) !== JSON.stringify(expected) && Date.now() < deadline) {
        yield* Effect.sleep(20)
        got = (yield* outcomes(api))["writer-model"]
      }
      assert.deepStrictEqual(got, expected)
    })
  /** The version a run is writing, from its live events. */
  const live = (events: ReadonlyArray<ChatEvent>) =>
    events.flatMap((e) => (e._tag === "Steps" || e._tag === "Delta" ? [e.versionId] : [])).at(-1)

  it.live("a reply stopped while the model answers the ask to send is stopped, not exhausted", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      let asked = 0
      // The first answer is plain text; the answer to the ask to send never comes.
      const writer = yield* mock((res) => {
        if (asked++ === 0) sse(res, completionChunks(["Just text."], { prompt_tokens: 9, completion_tokens: 2 }))
      })
      const events: Array<ChatEvent> = []
      yield* eventually(() => asked >= 2 && live(events) !== undefined).pipe(
        Effect.andThen(() => api.StopGeneration({ versionId: live(events)! })),
        Effect.ignore,
        Effect.forkScoped
      )
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${writer.url}/v1` },
        model: {},
        modelKey: "writer-model",
        state: TOOLS_ON,
        events
      })
      assert.strictEqual(version.status, "stopped")
      yield* counted(api, { replies: 1, ...none, stopped: 1 })
      // The inspector says so too.
      assert.strictEqual((yield* api.GetRunTranscript({ versionId: version.id })).contract?.outcome, "stopped")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a reply the request cap ended without a send is capped, not exhausted", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      let asked = 0
      // Text first; then, asked to write now without tools, a send the cap refuses.
      const writer = yield* mock((res) =>
        asked++ === 0
          ? sse(res, completionChunks(["Just text."], { prompt_tokens: 9, completion_tokens: 2 }))
          : sse(res, sendCall("Too late."))
      )
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${writer.url}/v1` },
        model: {},
        modelKey: "writer-model",
        state: [...TOOLS_ON, { key: "agent.request_cap", value: { cap: 2 } }]
      })
      assert.strictEqual(asked, 2)
      yield* counted(api, { replies: 1, ...none, capped: 1 })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a reasoning-only answer to the final request counts as capped", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      let asked = 0
      const writer = yield* mock((res) =>
        sse(
          res,
          asked++ === 0
            ? completionChunks(["Unsent text."], {})
            : [
                {
                  id: "cmpl-thinking",
                  object: "chat.completion.chunk",
                  model: "served-model",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", reasoning_content: "Considering the reply." },
                      finish_reason: null
                    }
                  ]
                },
                ...completionChunks([], {})
              ]
        )
      )
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${writer.url}/v1` },
        model: {},
        modelKey: "writer-model",
        state: [...TOOLS_ON, { key: "agent.request_cap", value: { cap: 2 } }]
      })
      assert.strictEqual(asked, 2)
      assert.notInclude(version.content, "Considering the reply.")
      yield* counted(api, { replies: 1, ...none, capped: 1 })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a resumed reply that is stopped, or fails, still counts once, as it ended", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      let then: "text" | "hold" | "error" = "text"
      let held = 0
      const writer = yield* mock((res) => {
        if (then === "text")
          return sse(res, completionChunks(["Just text."], { prompt_tokens: 9, completion_tokens: 2 }))
        if (then === "error") return json(res, 400, { error: { message: "The provider refused." } })
        held++
      })
      const events: Array<ChatEvent> = []
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${writer.url}/v1` },
        model: {},
        modelKey: "writer-model",
        state: TOOLS_ON,
        events
      })
      yield* counted(api, { replies: 1, ...none, exhausted: 1 })

      // Resumed, then stopped while the model writes: the reply is stopped, counted once.
      then = "hold"
      const resumed = yield* resume(api, version.id, version.slotId)
      yield* eventually(() => held > 0)
      yield* api.StopGeneration({ versionId: resumed.version.id }).pipe(Effect.ignore)
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)?.status, "stopped")
      yield* counted(api, { replies: 1, ...none, stopped: 1 })

      // Resumed again, and the provider fails: the reply failed, still counted once.
      then = "error"
      const failing = yield* resume(api, resumed.version.id, resumed.version.slotId)
      yield* eventually(() => finished(events, failing.version.id) !== undefined)
      assert.strictEqual(finished(events, failing.version.id)?.status, "failed")
      yield* counted(api, { replies: 1, ...none, failed: 1 })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a reply under Either counts for nothing", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const plain = yield* mock((res) =>
        sse(res, completionChunks(["Plain reply."], { prompt_tokens: 9, completion_tokens: 2 }))
      )
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${plain.url}/v1` },
        model: {},
        state: [...TOOLS_ON, { key: "output.contract", value: "both" }]
      })
      assert.strictEqual(version.content, "Plain reply.")
      assert.deepStrictEqual(yield* api.GetModelBehaviour(), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
