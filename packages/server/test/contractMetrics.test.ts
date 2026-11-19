// Per-model reply behaviour (spec/REPLY-CONTRACT.md milestone 4): each story reply under the send
// tool records its outcome when its run ends, and Settings → Models sums them per model; a reply
// carried on with Resume counts once, as the run that carried it on ended. Scripted providers only.
import { assert, describe, it } from "@effect/vitest"
import type { ServerResponse } from "node:http"
import type { PathEntry, VersionId } from "@dreamspan/shared/chat.ts"
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
