// The reply contract (spec/REPLY-CONTRACT.md milestone 1): a story reply with tools is given with
// `send_message` unless the chat says otherwise; text outside it is never the reply and never
// streams into the body; a turn that ends in text is nudged as reference-harness's forced completion, at
// most three times a run, counted from the transcript; then the reply fails visibly. The
// replying character may pass with `no_reply`, shown as a silent, swipeable version. Scripted
// providers only.
import { assert, describe, it } from "@effect/vitest"
import type { ServerResponse } from "node:http"
import { DatabaseSync } from "node:sqlite"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { PathEntry, VersionId } from "@rp/shared/chat.ts"
import { SEND_NUDGES, sendNudgeText } from "@rp/shared/agentInstructions.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, completionChunks, json, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const NUDGE = sendNudgeText(true)

const toolCall = (name: string, args: unknown, text = "", id = "call_1") => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(text ? { content: text } : {}),
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

type Message = { readonly role: string; readonly content: unknown }
type Body = {
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<{ function: { name: string } }>
}

const bodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)

const nudgesSent = (body: Body) => body.messages.filter((m) => m.role === "user" && m.content === NUDGE).length

/** A mock whose answer to each request the test picks by its index (0-based) and body. */
const scriptedMock = (answer: (n: number, body: Body, res: ServerResponse) => void) => {
  let n = 0
  return Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((request, res) => {
        if (request.path !== "/v1/chat/completions") return json(res, 404, { error: { message: "no" } })
        answer(n++, request.body as unknown as Body, res)
      })
    ),
    (m) => Effect.promise(() => m.close())
  )
}

const plain = (res: ServerResponse, text = "Plain words.") =>
  sse(res, completionChunks([text], { prompt_tokens: 80, completion_tokens: 3 }))

const transcriptOf = (dataDir: string, versionId: VersionId) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    const row = db
      .prepare(
        "SELECT p.transcript_json FROM versions v JOIN rollout_payloads p ON p.rollout_id = v.rollout_id WHERE v.id = ?"
      )
      .get(versionId) as { transcript_json: string }
    return JSON.parse(row.transcript_json) as Array<{ role: string; nudge?: number; content?: unknown }>
  } finally {
    db.close()
  }
}

/** Tools on, no tools of their own: only the contract's. */
const TOOLS_ON = [
  { key: "agent.enabled", value: { on: true } },
  { key: "agent.tools", value: { tools: [] } }
] as const

const resume = (api: Effect.Success<ReturnType<typeof client>>, versionId: VersionId, slotId: PathEntry["slotId"]) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
    return yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
  })

describe("reply contract", () => {
  it.live("by default a reply is sent with send_message: text before the send is a step, never the body", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((_n, _body, res) =>
        sse(res, toolCall("send_message", { message: "Ansel waves." }, "Let me think about the keeper."))
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.content, "Ansel waves.")
      assert.isNull(version.mark)
      const sent = bodies(mock.requests())
      assert.lengthOf(sent, 1)
      assert.deepStrictEqual(
        sent[0]!.tools?.map((t) => t.function.name),
        ["send_message", "no_reply"]
      )
      // The text never streamed into the body, so nothing had to be taken back.
      assert.isFalse(events.some((e) => e._tag === "Delta" && e.versionId === version.id && e.text.includes("think")))
      assert.isFalse(events.some((e) => e._tag === "Delta" && e.versionId === version.id && e.replace === true))
      assert.deepStrictEqual(yield* api.GetRolloutSteps({ versionId: version.id }), [
        { kind: "text", text: "Let me think about the keeper." }
      ])
      // The default instructions name both endings.
      assert.include(JSON.stringify(sent[0]!.messages.at(-1)), "call no_reply instead")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "text, a nudge, then the send: the nudge is appended after the turn and counted on the stored message",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* scriptedMock((n, _body, res) =>
          n === 0 ? plain(res) : sse(res, toolCall("send_message", { message: "Sent words." }))
        )
        const api = yield* client()
        const { version, events } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: TOOLS_ON
        })
        assert.strictEqual(version.content, "Sent words.")
        assert.isFalse(events.some((e) => e._tag === "Delta" && e.versionId === version.id && e.text.includes("Plain")))
        const [first, second] = bodies(mock.requests()) as [Body, Body]
        assert.deepStrictEqual(second.messages.slice(0, first.messages.length), first.messages)
        assert.deepStrictEqual(second.messages.slice(first.messages.length), [
          { role: "assistant", content: "Plain words." },
          { role: "user", content: NUDGE }
        ])
        const stored = transcriptOf(config.dataDir, version.id).filter((m) => m.role === "rpHarness")
        assert.deepStrictEqual(
          stored.map((m) => m.nudge),
          [1]
        )
        const run = yield* api.GetRunTranscript({ versionId: version.id })
        assert.deepInclude(
          run.entries.find((e) => e.role === "app"),
          { text: NUDGE, nudge: 1 }
        )
        // A nudged run has steps to show: the stray text, and its count includes the ask.
        assert.deepStrictEqual(yield* api.GetRolloutSteps({ versionId: version.id }), [
          { kind: "text", text: "Plain words." }
        ])
        assert.strictEqual(version.steps?.count, 1)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("three nudges, then the reply fails visibly with its stray text in the steps; Resume tries once more", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let sends = false
      const mock = yield* scriptedMock((n, _body, res) =>
        sends ? sse(res, toolCall("send_message", { message: "At last." })) : plain(res, `Text ${n + 1}.`)
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.status, "failed")
      assert.deepStrictEqual(version.error, {
        class: "contract",
        message: "The model didn't send a reply: it wrote text 4 times without calling send_message."
      })
      assert.strictEqual(version.content, "")
      const sent = bodies(mock.requests())
      assert.lengthOf(sent, SEND_NUDGES + 1)
      assert.deepStrictEqual(sent.map(nudgesSent), [0, 1, 2, 3])
      assert.deepStrictEqual(yield* api.GetRolloutSteps({ versionId: version.id }), [
        { kind: "text", text: "Text 1." },
        { kind: "text", text: "Text 2." },
        { kind: "text", text: "Text 3." },
        { kind: "text", text: "Text 4." }
      ])
      // Resume cuts the last text and answers the last nudge again: one more attempt.
      sends = true
      const entry = yield* resume(api, version.id, version.slotId)
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const resumed = finished(events, entry.version.id)!
      assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
      assert.strictEqual(resumed.content, "At last.")
      const after = bodies(mock.requests())
      assert.lengthOf(after, SEND_NUDGES + 2)
      // The request the fourth text answered, sent again: three nudges, none added.
      assert.deepStrictEqual(after.at(-1), sent.at(-1))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("Resume after a nudge never nudges the answered turn again and goes on with the count", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // The first request is answered in text, the nudge's answer fails; after Resume, text again.
      const mock = yield* scriptedMock((n, _body, res) =>
        n === 1 ? json(res, 400, { error: { message: "Bad request." } }) : plain(res, `Text ${n}.`)
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.status, "failed")
      assert.notStrictEqual(version.error?.class, "contract")
      const failed = bodies(mock.requests())
      assert.deepStrictEqual(failed.map(nudgesSent), [0, 1])
      const entry = yield* resume(api, version.id, version.slotId)
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const resumed = finished(events, entry.version.id)!
      const sent = bodies(mock.requests()).slice(failed.length)
      // The failed request again, as it was; then the count goes on from one: two more nudges.
      assert.deepStrictEqual(sent[0], failed[1])
      assert.deepStrictEqual(sent.map(nudgesSent), [1, 2, 3])
      assert.strictEqual(resumed.status, "failed")
      assert.strictEqual(resumed.error?.class, "contract")
      assert.deepStrictEqual(
        transcriptOf(config.dataDir, entry.version.id).flatMap((m) => (m.role === "rpHarness" ? [m.nudge] : [])),
        [1, 2, 3]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("an appended nudge leaves the cached prefix as it was and takes the tail marker", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const start = {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "mock-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 }
        }
      }
      let n = 0
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            anthropicSse(
              res,
              n++ === 0
                ? [
                    start,
                    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Plain words." } },
                    { type: "content_block_stop", index: 0 },
                    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
                    { type: "message_stop" }
                  ]
                : [
                    start,
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "tool_use", id: "toolu_1", name: "send_message", input: {} }
                    },
                    {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "input_json_delta", partial_json: '{"message":"Sent words."}' }
                    },
                    { type: "content_block_stop", index: 0 },
                    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
                    { type: "message_stop" }
                  ]
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
        model: { cacheBreakpoints: "explicit" },
        state: TOOLS_ON
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.content, "Sent words.")
      type Block = { type: string; text?: string; cache_control?: unknown }
      type AnthropicBody = {
        system?: unknown
        tools?: unknown
        messages: Array<{ role: string; content: Array<Block> | string }>
      }
      const sent = mock
        .requests()
        .filter((r) => r.path.startsWith("/v1/messages"))
        .map((r) => r.body as unknown as AnthropicBody)
      assert.lengthOf(sent, 2)
      const [first, second] = sent as [AnthropicBody, AnthropicBody]
      // System and tools, with their markers, are exactly the first request's.
      assert.deepStrictEqual(second.system, first.system)
      assert.deepStrictEqual(second.tools, first.tools)
      const blocks = (content: Array<Block> | string) =>
        typeof content === "string" ? [{ type: "text", text: content }] : content
      const strip = (content: Array<Block> | string) => blocks(content).map(({ cache_control: _, ...b }) => b)
      assert.deepStrictEqual(
        second.messages.slice(0, first.messages.length).map((m) => [m.role, strip(m.content)]),
        first.messages.map((m) => [m.role, strip(m.content)])
      )
      // The prefix's own markers stay where they were (the first request's tail aside).
      const markers = (m: { content: Array<Block> | string }) =>
        blocks(m.content).map((b) => b.cache_control !== undefined)
      assert.deepStrictEqual(
        second.messages.slice(0, first.messages.length - 1).map(markers),
        first.messages.slice(0, -1).map(markers)
      )
      const suffix = second.messages.slice(first.messages.length)
      assert.deepStrictEqual(
        suffix.map((m) => [m.role, strip(m.content)]),
        [
          ["assistant", [{ type: "text", text: "Plain words." }]],
          ["user", [{ type: "text", text: NUDGE }]]
        ]
      )
      assert.isDefined(blocks(suffix[1]!.content).at(-1)!.cache_control, JSON.stringify(second.messages))
      assert.isAtMost((JSON.stringify(second).match(/cache_control/g) ?? []).length, 4)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "a chat that sets Either keeps its requests: one send tool, the old instructions, text taken as the reply",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* scriptedMock((_n, _body, res) => plain(res, "Ansel waves."))
        const api = yield* client()
        const { version, events } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: [...TOOLS_ON, { key: "output.contract", value: "both" }]
        })
        assert.strictEqual(version.content, "Ansel waves.")
        const sent = bodies(mock.requests())
        assert.lengthOf(sent, 1)
        // Exactly the request a `both` chat sent before the send tool became the default.
        assert.deepStrictEqual(sent[0]!.tools as unknown, [
          {
            type: "function",
            function: {
              name: "send_message",
              description:
                "Sends your reply: the next message of the story, written as it should appear. Call it once, when the reply is ready; it ends your turn.",
              parameters: {
                type: "object",
                properties: { message: { type: "string", description: "The message, exactly as it should appear." } },
                required: ["message"]
              }
            }
          }
        ])
        const last = sent[0]!.messages.at(-1)!
        assert.include(
          String(last.content),
          "When you're ready, send the reply with send_message, or write it as your answer."
        )
        assert.notInclude(JSON.stringify(sent[0]), "no_reply")
        // Its text streamed as the reply, as before.
        assert.isTrue(events.some((e) => e._tag === "Delta" && e.versionId === version.id && e.text.includes("Ansel")))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("no_reply in a 1:1 chat: a silent version, and the turn goes back to the user", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((n, _body, res) =>
        n === 0 ? sse(res, toolCall("no_reply", {})) : sse(res, toolCall("send_message", { message: "Mira answers." }))
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.mark, "silent")
      assert.strictEqual(version.content, "")
      assert.lengthOf(bodies(mock.requests()), 1)
      assert.isEmpty(yield* api.ListQueued({ chatId: chat.id }))
      assert.isEmpty(yield* api.GetRolloutSteps({ versionId: version.id }))
      // A swipe of the silent line is an actual reply.
      const me = yield* api.Whoami()
      const { entry } = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      const reply = finished(events, swipe.version.id)!
      assert.strictEqual(reply.content, "Mira answers.")
      assert.isNull(reply.mark)
      // The silent version is still one of the slot's, and it's left out of the next request.
      const versions = yield* api.ListVersions({ slotId: version.slotId })
      assert.deepStrictEqual(
        versions.map((v) => v.mark),
        ["silent", null]
      )
      const [, second] = bodies(mock.requests()) as [Body, Body]
      assert.notInclude(JSON.stringify(second.messages), '"content":""')
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("no_reply in a round: the next character replies, and doesn't see the pass", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((n, _body, res) =>
        n === 0 ? sse(res, toolCall("no_reply", {})) : sse(res, toolCall("send_message", { message: "Wren answers." }))
      )
      const api = yield* client()
      const events: Array<ChatEvent> = []
      const { version, chat } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON,
        characters: ["Wren"],
        auto: { speaker: "Mira", round: ["Wren"] },
        events
      })
      assert.strictEqual(version.mark, "silent")
      // Wren's reply was queued behind the pass and posts when it ends.
      const deadline = Date.now() + 20_000
      let path: ReadonlyArray<PathEntry> = []
      while (Date.now() < deadline) {
        path = (yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }))
          .entries
        if (path.at(-1)?.version.content === "Wren answers.") break
        yield* Effect.sleep(20)
      }
      assert.deepStrictEqual(
        path.slice(-2).map((e) => [e.version.mark, e.version.content]),
        [
          ["silent", ""],
          [null, "Wren answers."]
        ]
      )
      assert.lengthOf(bodies(mock.requests()), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
