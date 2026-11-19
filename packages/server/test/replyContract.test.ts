// The reply contract (spec/REPLY-CONTRACT.md milestone 1): a story reply with tools is given with
// `send_message` unless the chat says otherwise; text outside it is never the reply and never
// streams into the body; a turn that ends in text is nudged as reference-harness's forced completion, at
// most three times a run, counted from the transcript; then the reply fails visibly. The
// replying character may pass with `no_reply`, shown as a silent, swipeable version. Scripted
// providers only.
import { assert, describe, it } from "@effect/vitest"
import type { ServerResponse } from "node:http"
import { DatabaseSync } from "node:sqlite"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { EntityId, PathEntry, VersionId } from "@dreamspan/shared/chat.ts"
import { SEND_NUDGE_PROMPT, SEND_NUDGES, sendNudgeText } from "@dreamspan/shared/agentInstructions.ts"
import { agentInstructionsPrompt } from "@dreamspan/shared/presetOrder.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
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

/** The reply being written, from the chat's events. */
const generating = (events: ReadonlyArray<ChatEvent>) =>
  events.flatMap((e) => (e._tag === "Slot" && e.entry.version.status === "generating" ? [e.entry.version] : [])).at(-1)

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
        const stored = transcriptOf(config.dataDir, version.id).filter((m) => m.role === "rpApp")
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
          { kind: "text", text: "Plain words.", asked: true }
        ])
        assert.strictEqual(version.steps?.count, 1)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("the preset's own nudge is sent instead of the default, its macros filled in", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((n, _body, res) =>
        n === 0 ? plain(res) : sse(res, toolCall("send_message", { message: "Sent words." }))
      )
      const stPreset = importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        presetFields: {
          prompts: [
            ...stPreset.prompts,
            {
              ...agentInstructionsPrompt,
              identifier: SEND_NUDGE_PROMPT.identifier,
              name: SEND_NUDGE_PROMPT.label,
              role: "user",
              content: "{{char}}, send that with send_message."
            }
          ]
        },
        state: TOOLS_ON
      })
      assert.strictEqual(version.content, "Sent words.")
      const [first, second] = bodies(mock.requests()) as [Body, Body]
      // Never sent by assembly: the first request doesn't hold it.
      assert.notInclude(JSON.stringify(first.messages), "send that with send_message")
      assert.deepStrictEqual(second.messages.at(-1), { role: "user", content: "Mira, send that with send_message." })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

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
        { kind: "text", text: "Text 1.", asked: true },
        { kind: "text", text: "Text 2.", asked: true },
        { kind: "text", text: "Text 3.", asked: true },
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
        transcriptOf(config.dataDir, entry.version.id).flatMap((m) => (m.role === "rpApp" ? [m.nudge] : [])),
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

  it.live("a turn of a character you play is never offered the pass, or any tool", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((_n, body, res) =>
        body.tools ? sse(res, toolCall("send_message", { message: "Mira answers." })) : plain(res, "Tobin shrugs.")
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.content, "Mira answers.")
      // Tobin is the fixture's character played by the user: a persona turn.
      const tobin = (yield* api.ListCards()).find((card) => card.name === "Tobin")!.entityId as EntityId
      const { entry } = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false, speakerEntityId: tobin })
      )
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const own = finished(events, entry.version.id)!
      assert.strictEqual(own.content, "Tobin shrugs.")
      assert.isNull(own.mark)
      const [first, second] = bodies(mock.requests()) as [Body, Body]
      assert.include(
        first.tools!.map((t) => t.function.name),
        "no_reply"
      )
      assert.isUndefined(second.tools)
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
  it.live(
    "Resume of a turn stopped in its text, past the third nudge, writes it again with tools on a prefill model, never into the body",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        let hold = true
        const mock = yield* scriptedMock((n, _body, res) => {
          if (n < 3) return plain(res, `Text ${n + 1}.`)
          if (n === 3 && hold) {
            // The fourth turn's text, cut off by a stop.
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.write(`data: ${JSON.stringify(completionChunks(["Still writing as text"], {})[0])}\n\n`)
            return
          }
          sse(res, toolCall("send_message", { message: "Sent words." }))
        })
        const api = yield* client()
        const events: Array<ChatEvent> = []
        yield* Effect.forkScoped(
          generateReply(api, {
            connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
            // A model that takes an assistant prefill: text cut off could be carried on, but not here.
            model: { prefill: "assistant" },
            state: TOOLS_ON,
            events
          })
        )
        yield* eventually(() => mock.requests().filter((r) => r.path === "/v1/chat/completions").length === 4)
        const version = generating(events)!
        yield* Effect.sleep("400 millis")
        yield* api.StopGeneration({ versionId: version.id })
        yield* eventually(() => finished(events, version.id) !== undefined)
        assert.strictEqual(finished(events, version.id)!.status, "stopped")
        hold = false
        const entry = yield* resume(api, version.id, version.slotId)
        // Nothing of the stopped text is carried into the resumed version.
        assert.strictEqual(entry.version.content, "")
        yield* eventually(() => finished(events, entry.version.id) !== undefined)
        const resumed = finished(events, entry.version.id)!
        assert.strictEqual(resumed.status, "complete", JSON.stringify(resumed.error))
        assert.strictEqual(resumed.content, "Sent words.")
        const sent = bodies(mock.requests())
        const again = sent.at(-1)!
        // One attempt with tools, answering the third nudge, with no prefill of the stopped text.
        assert.include(
          again.tools!.map((t) => t.function.name),
          "send_message"
        )
        assert.deepStrictEqual(again.messages.at(-1), { role: "user", content: NUDGE })
        assert.strictEqual(nudgesSent(again), 3)
        assert.isFalse(
          events.some((e) => e._tag === "Delta" && (e.text.includes("Text") || e.text.includes("Still writing"))),
          "stray text never streams into a body"
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("a turn stopped in its text before any nudge shows its text in the steps", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((_n, _body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify(completionChunks(["Three paragraphs of plain text"], {})[0])}\n\n`)
      })
      const api = yield* client()
      const events: Array<ChatEvent> = []
      yield* Effect.forkScoped(
        generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          state: TOOLS_ON,
          events
        })
      )
      yield* eventually(() => mock.requests().some((r) => r.path === "/v1/chat/completions"))
      const version = generating(events)!
      yield* Effect.sleep("400 millis")
      yield* api.StopGeneration({ versionId: version.id })
      yield* eventually(() => finished(events, version.id) !== undefined)
      assert.strictEqual(finished(events, version.id)!.content, "")
      assert.deepStrictEqual(yield* api.GetRolloutSteps({ versionId: version.id }), [
        { kind: "text", text: "Three paragraphs of plain text" }
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a swipe of the silent line isn't offered the pass: it asks for an actual reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      // A model that passes whenever it may.
      const mock = yield* scriptedMock((_n, body, res) =>
        body.tools?.some((t) => t.function.name === "no_reply")
          ? sse(res, toolCall("no_reply", {}))
          : sse(res, toolCall("send_message", { message: "Mira answers." }))
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.mark, "silent")
      const me = yield* api.Whoami()
      const { entry } = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
      const swipe = yield* api.Regenerate({ slotId: entry.slotId, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, swipe.version.id) !== undefined)
      const reply = finished(events, swipe.version.id)!
      assert.strictEqual(reply.content, "Mira answers.")
      assert.isNull(reply.mark)
      const [, second] = bodies(mock.requests()) as [Body, Body]
      assert.deepStrictEqual(
        second.tools!.map((t) => t.function.name),
        ["send_message"]
      )
      assert.notInclude(JSON.stringify(second.messages), "no_reply")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("the cap's last request wins over running out of nudges: its answer is the reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((n, _body, res) => plain(res, n === 4 ? "Final words." : `Text ${n + 1}.`))
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [...TOOLS_ON, { key: "agent.request_cap", value: { cap: 5 } }]
      })
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.content, "Final words.")
      const sent = bodies(mock.requests())
      assert.lengthOf(sent, 5)
      assert.deepStrictEqual(sent.map(nudgesSent), [0, 1, 2, 3, 3])
      assert.isUndefined(sent[4]!.tools)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("after a Resume that fails again, the failure counts every text written, the cut one too", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((n, _body, res) => plain(res, `Text ${n + 1}.`))
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.include(version.error?.message ?? "", "wrote text 4 times")
      const entry = yield* resume(api, version.id, version.slotId)
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const again = finished(events, entry.version.id)!
      assert.strictEqual(again.status, "failed")
      assert.strictEqual(
        again.error?.message,
        "The model didn't send a reply: it wrote text 5 times without calling send_message."
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a nudged turn that wrote nothing is still a step, and counted", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((n, _body, res) =>
        n === 0 ? plain(res, "") : sse(res, toolCall("send_message", { message: "Sent words." }))
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.content, "Sent words.")
      assert.deepStrictEqual(yield* api.GetRolloutSteps({ versionId: version.id }), [
        { kind: "text", text: "", asked: true }
      ])
      assert.strictEqual(version.steps?.count, 1)
      // The inspector shows it as an empty text step; it can't be changed, only carried on from.
      const run = yield* api.GetRunTranscript({ versionId: version.id })
      assert.deepInclude(
        run.entries.flatMap((e) => (e.role === "assistant" ? e.parts : [])),
        { type: "text", text: "", step: 0 }
      )
      const me = yield* api.Whoami()
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
      const edited = yield* Effect.flip(
        api.ResumeFromStep({
          versionId: version.id,
          step: 0,
          edit: { kind: "text", text: "Words after all." },
          expectedRowVersion: slot.entry.rowVersion
        })
      )
      assert.strictEqual(edited._tag, "NotResumable")
      const resumed = yield* api.ResumeFromStep({
        versionId: version.id,
        step: 0,
        expectedRowVersion: slot.entry.rowVersion
      })
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.content, "Sent words.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a story with a workshop's several-message contract stored gets the default send tool", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* scriptedMock((_n, _body, res) => sse(res, toolCall("send_message", { message: "Hi." })))
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [...TOOLS_ON, { key: "output.contract", value: "several" }]
      })
      assert.strictEqual(version.content, "Hi.")
      assert.deepStrictEqual(
        bodies(mock.requests())[0]!.tools!.map((t) => t.function.name),
        ["send_message", "no_reply"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
