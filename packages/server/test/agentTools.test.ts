// The read tools over the chat's history (spec/AGENTIC.md §4.5), run by a scripted model in the
// narrator mode. Causal: the reply being written, and a later version of its message, are
// never found; only the messages before it are.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const call = (id: string, name: string, args: unknown) => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [],
    usage: { prompt_tokens: 90, completion_tokens: 5 }
  }
]

const script: ReadonlyArray<readonly [string, unknown]> = [
  ["search_chat", { query: "Ansel" }],
  ["search_chat", { query: "late" }],
  ["read_messages", { from: 1 }],
  ["expand_summary", { messages: "1–2" }],
  ["send_message", { message: "Ansel waves." }]
]

/** Each request takes the next call of the script, by how many results it already has. */
const scripted = (request: Recorded, res: ServerResponse) => {
  const done = ((request.body?.messages ?? []) as Array<{ role: string }>).filter((m) => m.role === "tool").length
  const [name, args] = script[Math.min(done, script.length - 1)]!
  sse(res, call(`call_${done}`, name, args))
}

describe("agent read tools", () => {
  it.live("search, read and summaries see only the messages before the reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(scripted)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "orchestration.mode", value: { mode: "narrator" } }]
      })
      assert.strictEqual(version.content, "Ansel waves.")
      const results = (versionId: typeof version.id) =>
        api
          .GetRolloutSteps({ versionId })
          .pipe(Effect.map((steps) => steps.map((s) => (s.kind === "tool" ? [s.tool, s.result] : [s.kind]))))
      const expected = [
        ["search_chat", "No earlier messages match “Ansel”."],
        ["search_chat", "Message 1, Mira: *Mira looks up.* Late again, Tobin."],
        [
          "read_messages",
          "Message 1, Mira: *Mira looks up.* Late again, Tobin.\n\nMessage 2, Tobin: The road flooded."
        ],
        ["expand_summary", "This chat has no summaries."]
      ]
      assert.deepStrictEqual(yield* results(version.id), expected)

      // A second version of the reply's message: the first one, after its parent, isn't seen.
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const { entry } = yield* reader.GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      assert.strictEqual(finished(events, swipe.version.id)!.content, "Ansel waves.")
      assert.deepStrictEqual(yield* results(swipe.version.id), expected)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
