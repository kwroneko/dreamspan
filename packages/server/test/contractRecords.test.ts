// The reply contract's mechanical records (spec/REPLY-CONTRACT.md milestone 2): `contractAttempts`
// over a transcript and its cut spans, the failure types, the markup the assembler writes kept in
// step with what the records recognize, and the run inspector's view of a real run. Scripted
// providers only.
import { assert, describe, it } from "@effect/vitest"
import type { ServerResponse } from "node:http"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { PathEntry, VersionId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { CONTEXT_TAGS, looksLikeContextMarkup, nameBlock, speakerLabel } from "../src/assembler/contextMarkup.ts"
import { summaryBlock } from "../src/assembler/lcm.ts"
import { contractAttempts, looksLikeTextualToolCall, runOutcome } from "../src/agent/contract.ts"
import { toolData } from "../src/agent/toolData.ts"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, json, sse, startMockProvider } from "./support/mockProvider.ts"

const request = { role: "rpRequest", timestamp: 0, contract: "send_message" } as unknown as AgentMessage
const nudge = (n: number) => ({ role: "rpApp", content: "Send it.", nudge: n, timestamp: 0 }) as unknown as AgentMessage
const writeNow = { role: "rpApp", content: "Write the reply now.", timestamp: 0 } as unknown as AgentMessage
const turn = (parts: ReadonlyArray<unknown>, stopReason = "stop") =>
  ({ role: "assistant", content: parts, stopReason, timestamp: 0 }) as unknown as AgentMessage
const text = (t: string, stopReason = "stop") => turn([{ type: "text", text: t }], stopReason)
const call = (name: string, id: string, args: unknown = {}) => turn([{ type: "toolCall", id, name, arguments: args }])
const result = (name: string, id: string, isError = false) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: isError ? "No." : "Done." }],
    isError,
    timestamp: 0
  }) as unknown as AgentMessage

describe("contractAttempts", () => {
  it("a send at once is clean, one attempt", () => {
    const record = contractAttempts([request, call("send_message", "a"), result("send_message", "a")], [])
    assert.deepStrictEqual(record, {
      attempts: [{ ending: "sent", failures: [], cut: false }],
      nudges: 0,
      outcome: "clean"
    })
  })

  it("text, a nudge, then a send is recovered; tools between don't end an attempt", () => {
    const record = contractAttempts(
      [
        request,
        text("Let me think."),
        nudge(1),
        call("search_chat", "s"),
        result("search_chat", "s"),
        call("send_message", "a"),
        result("send_message", "a")
      ],
      []
    )
    assert.deepStrictEqual(record.attempts, [
      { ending: "failed", failures: ["text_only"], cut: false },
      { ending: "sent", failures: [], cut: false }
    ])
    assert.strictEqual(record.nudges, 1)
    assert.strictEqual(record.outcome, "recovered")
  })

  it("a pass after nudges gave up; a pass at once is clean", () => {
    assert.strictEqual(
      contractAttempts([request, text(""), nudge(1), call("no_reply", "p"), result("no_reply", "p")], []).outcome,
      "gave_up"
    )
    assert.strictEqual(contractAttempts([request, call("no_reply", "p"), result("no_reply", "p")], []).outcome, "clean")
  })

  it("names every failure type, in precedence order", () => {
    const record = contractAttempts(
      [
        request,
        call("send_message", "a"),
        result("send_message", "a", true),
        text('<tool_call>{"name": "send_message"}</tool_call>'),
        nudge(1),
        text("Mira: *waves*"),
        nudge(2),
        text(""),
        nudge(3),
        text('send_message({"message": "Hi"})')
      ],
      [],
      { names: ["Mira", "Ana"] }
    )
    assert.deepStrictEqual(
      record.attempts.map((a) => a.failures),
      [
        ["invalid_tool_call", "textual_tool_call", "text_only"],
        ["context_mimicry", "text_only"],
        ["empty"],
        ["textual_tool_call", "text_only"]
      ]
    )
    assert.strictEqual(record.outcome, "exhausted")
  })

  it("the answer to the cap's write-now is the reply", () => {
    const record = contractAttempts([request, text("Thinking."), nudge(1), writeNow, text("Final words.")], [])
    assert.deepStrictEqual(record.attempts.at(-1), { ending: "written", failures: [], cut: false })
    assert.strictEqual(record.outcome, "recovered")
  })

  it("a stopped or failed ending is no verdict, and neither is a run still going", () => {
    assert.strictEqual(contractAttempts([request, text("Half", "aborted")], []).outcome, null)
    assert.strictEqual(contractAttempts([request, text("Hm."), nudge(1)], []).outcome, null)
    assert.strictEqual(
      contractAttempts([request, call("search_chat", "s"), result("search_chat", "s")], []).outcome,
      null
    )
    assert.lengthOf(contractAttempts([request, text("Half", "error")], []).attempts, 0)
  })

  it("an attempt a Resume cut counts, marked cut; a step edit's cut doesn't", () => {
    const kept = [request, text("1"), nudge(1), text("2"), nudge(2), text("3"), nudge(3)]
    const resumed = contractAttempts(
      [...kept, call("send_message", "a"), result("send_message", "a")],
      [{ reason: "resume", forkIndex: kept.length, messages: [text("4")] }]
    )
    assert.deepStrictEqual(
      resumed.attempts.map((a) => [a.ending, a.cut]),
      [
        ["failed", false],
        ["failed", false],
        ["failed", false],
        ["failed", true],
        ["sent", false]
      ]
    )
    assert.strictEqual(resumed.outcome, "recovered")
    // A step edit replaced what the model wrote: what it cut isn't the model's attempt.
    const edited = contractAttempts(
      [request, text("Edited."), nudge(1), call("send_message", "a"), result("send_message", "a")],
      [{ reason: "edit", forkIndex: 1, messages: [text("Original."), nudge(1), text("Again.")] }]
    )
    assert.deepStrictEqual(
      edited.attempts.map((a) => a.ending),
      ["failed", "sent"]
    )
    assert.isFalse(edited.attempts.some((a) => a.cut))
    // A stop's cut (the turn cut off) is no attempt: the resumed run's ending is.
    const stopped = contractAttempts(
      [request, call("send_message", "a"), result("send_message", "a")],
      [{ reason: "resume", forkIndex: 1, messages: [text("Half", "aborted")] }]
    )
    assert.deepStrictEqual(stopped, {
      attempts: [{ ending: "sent", failures: [], cut: false }],
      nudges: 0,
      outcome: "clean"
    })
  })

  it("only the run after the frozen request counts", () => {
    const record = contractAttempts(
      [text("Before."), request, call("send_message", "a"), result("send_message", "a")],
      []
    )
    assert.lengthOf(record.attempts, 1)
  })
})

describe("runOutcome: what an ended run records", () => {
  const ended = { exhausted: false, stopped: false, failed: false, capped: false }
  it("a stop before the nudge is stopped, never exhausted", () => {
    // Plain text, then the Stop: the turn ended "stop" and no nudge followed it.
    const record = contractAttempts([request, text("Mira waves.")], [])
    assert.strictEqual(record.outcome, "exhausted")
    assert.strictEqual(runOutcome(record, { ...ended, stopped: true }), "stopped")
    // Stopped after nudges, while a nudge's answer was being written.
    const later = contractAttempts([request, text("Hi."), nudge(1), text("Mira", "aborted")], [])
    assert.strictEqual(runOutcome(later, { ...ended, stopped: true }), "stopped")
  })

  it("the request cap ending a run on a refused send is capped; running out of nudges is exhausted", () => {
    const capped = contractAttempts(
      [request, text("Hi."), writeNow, call("send_message", "a"), result("send_message", "a", true)],
      []
    )
    assert.strictEqual(capped.outcome, "exhausted")
    assert.strictEqual(runOutcome(capped, { ...ended, capped: true }), "capped")
    const exhausted = contractAttempts(
      [request, text("a"), nudge(1), text("b"), nudge(2), text("c"), nudge(3), text("d")],
      []
    )
    assert.strictEqual(runOutcome(exhausted, { ...ended, exhausted: true, capped: true }), "exhausted")
  })

  it("a reply given stays as given; an error is failed", () => {
    const sent = contractAttempts(
      [request, text("Hi."), nudge(1), call("send_message", "a"), result("send_message", "a")],
      []
    )
    assert.strictEqual(runOutcome(sent, { ...ended, stopped: true }), "recovered")
    assert.strictEqual(
      runOutcome(contractAttempts([request, writeNow, text("Hi.")], []), { ...ended, capped: true }),
      "clean"
    )
    assert.strictEqual(
      runOutcome(contractAttempts([request, text("", "error")], []), { ...ended, failed: true }),
      "failed"
    )
  })
})

describe("the context's markup", () => {
  it("everything the assembler wraps the context in is recognized as copied markup", () => {
    const names = ["Mira", "Ana"]
    const written = [
      speakerLabel("Mira", "Hello there."),
      nameBlock("Ana", "Her own note."),
      summaryBlock({ level: 1, from: 0, to: 9, content: "Earlier." }),
      toolData("Some data.")
    ]
    for (const w of written) assert.isTrue(looksLikeContextMarkup(w, names), w)
    for (const tag of CONTEXT_TAGS) assert.isTrue(looksLikeContextMarkup(`<${tag} a="1">x</${tag}>`, []), tag)
    // Prose that names a character isn't markup.
    for (const prose of ["Mira waves at Ana.", "She said: hello", "<em>Mira</em> smiles."])
      assert.isFalse(looksLikeContextMarkup(prose, names), prose)
  })

  it("tool-call markup written as text", () => {
    for (const t of [
      "<function=send_message>",
      "[TOOL_CALLS] send_message",
      '{"name": "search_chat", "arguments": {}}',
      'send_message {"message": "Hi"}'
    ])
      assert.isTrue(looksLikeTextualToolCall(t, ["search_chat"]), t)
    assert.isFalse(looksLikeTextualToolCall("She sent a message.", ["search_chat"]))
  })
})

const plain = (res: ServerResponse, t: string) =>
  sse(res, completionChunks([t], { prompt_tokens: 80, completion_tokens: 3 }))

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

const resume = (api: Effect.Success<ReturnType<typeof client>>, versionId: VersionId, slotId: PathEntry["slotId"]) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
    return yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
  })

describe("the run inspector's attempts", () => {
  it.live("an exhausted reply, then a Resume that sends: every attempt, the cut one marked", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let sends = false
      let n = 0
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((req, res) => {
            if (req.path !== "/v1/chat/completions") return json(res, 404, { error: { message: "no" } })
            n++
            if (sends) sse(res, sendCall("At last."))
            else plain(res, n === 2 ? "Mira: *waves*" : `Text ${n}.`)
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON
      })
      assert.strictEqual(version.error?.class, "contract")
      const failed = yield* api.GetRunTranscript({ versionId: version.id })
      assert.deepStrictEqual(failed.contract, {
        attempts: [
          { ending: "failed", failures: ["text_only"], cut: false },
          { ending: "failed", failures: ["context_mimicry", "text_only"], cut: false },
          { ending: "failed", failures: ["text_only"], cut: false },
          { ending: "failed", failures: ["text_only"], cut: false }
        ],
        nudges: 3,
        outcome: "exhausted"
      })
      sends = true
      const entry = yield* resume(api, version.id, version.slotId)
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const resumed = yield* api.GetRunTranscript({ versionId: entry.version.id })
      assert.deepStrictEqual(
        resumed.contract?.attempts.map((a) => [a.ending, a.cut]),
        [
          ["failed", false],
          ["failed", false],
          ["failed", false],
          ["failed", true],
          ["sent", false]
        ]
      )
      assert.strictEqual(resumed.contract?.outcome, "recovered")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a run under Either has no contract record", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_req, res) => plain(res, "Plain reply."))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [...TOOLS_ON, { key: "output.contract", value: "both" }]
      })
      assert.strictEqual(version.content, "Plain reply.")
      assert.isUndefined((yield* api.GetRunTranscript({ versionId: version.id })).contract)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
