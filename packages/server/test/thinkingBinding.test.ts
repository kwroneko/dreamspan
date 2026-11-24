import { withoutThinking } from "../src/agent/resume.ts"
// Signed thinking on the wire (ARCHITECTURE §6 "Signed thinking"): every way the history before
// a signed block can change, as the request bytes show it, against a checker that enforces the
// provider's documented rule (support/enforcingAnthropic.ts). (a) The blocks are absent after a
// change and present without one; (b) every request the binding lets through passes the check.
import { describe, expect, it } from "vitest"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import {
  anthropicBinding,
  bindThinking,
  openRouterClaudeBinding,
  refusesSigned,
  responsesBinding,
  thinkingRecord,
  type ThinkingRecord
} from "../src/providers/thinkingBinding.ts"
import { applyAnthropicToolLoading } from "../src/providers/toolLoading.ts"
import { type AnthropicBody, type Issued, prefixOf, verify } from "./support/enforcingAnthropic.ts"

const written = { connectionId: "conn-a", modelId: "model-a" }
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

type Wire = AnthropicBody["messages"][number]

/** A conversation as both sides see it: the wire messages, the app's transcript and the provider's signatures. */
interface Conversation {
  system: string
  readonly tools: Array<{ name: string; description: string; input_schema: unknown }>
  readonly wire: Array<Wire>
  readonly pi: Array<Message>
  readonly issued: Map<string, Issued>
}

const tool = (name: string) => ({ name, description: `${name} tool`, input_schema: { type: "object" } })

const start = (): Conversation => ({
  system: "You narrate a lighthouse story.",
  tools: [tool("look_up"), tool("search_chat")],
  wire: [
    { role: "user", content: "Mira climbs the stairs." },
    { role: "assistant", content: [{ type: "text", text: "The lamp flickers." }] },
    { role: "user", content: [{ type: "text", text: "Who keeps the light?", cache_control: { type: "ephemeral" } }] }
  ],
  pi: [],
  issued: new Map()
})

const payloadOf = (c: Conversation): Record<string, unknown> => ({
  model: "claude-test",
  system: [{ type: "text", text: c.system }],
  tools: c.tools,
  messages: c.wire
})

let n = 0
/**
 * The provider answers the payload (as the binding let it through) with a signed turn: the app
 * records it, the provider remembers what it was bound to, and the turn and a result go on.
 */
const answer = (c: Conversation, sent: Record<string, unknown>, redacted = false) => {
  const signature = `sig-${++n}`
  const body = sent as unknown as AnthropicBody
  const prev =
    body.messages
      .flatMap((m) =>
        m.role === "assistant" && Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === "thinking" || b.type === "redacted_thinking")
              .map((b) => String(b.type === "redacted_thinking" ? b.data : b.signature))
          : []
      )
      .at(-1) ?? null
  c.issued.set(signature, { prefix: prefixOf(body, body.messages.length), prev, source: structuredClone(body) })
  const record: ThinkingRecord = thinkingRecord(anthropicBinding, sent, written)
  const id = `call-${n}`
  const piTurn = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage,
    stopReason: "toolUse",
    timestamp: 0,
    content: [
      redacted
        ? { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: signature, redacted: true }
        : { type: "thinking", thinking: `Plan ${n}.`, thinkingSignature: signature },
      { type: "toolCall", id, name: "look_up", arguments: { topic: "keeper" } }
    ],
    thinkingRecord: record
  } as unknown as AssistantMessage
  c.pi.push(piTurn, {
    role: "toolResult",
    toolCallId: id,
    toolName: "look_up",
    content: [{ type: "text", text: "The keeper is Ansel." }],
    isError: false,
    timestamp: 0
  })
  c.wire.push(
    {
      role: "assistant",
      content: [
        redacted
          ? { type: "redacted_thinking", data: signature }
          : { type: "thinking", thinking: `Plan ${n}.`, signature },
        { type: "tool_use", id, name: "look_up", input: { topic: "keeper" } }
      ]
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "The keeper is Ansel." }] }
  )
}

const bind = (c: Conversation, payload = payloadOf(c), who = written, mode: "check" | "strip" | "keep" = "check") =>
  bindThinking(anthropicBinding, payload, { context: c.pi, ...who, mode })

/** The signatures a payload carries, in order. */
const signed = (payload: Record<string, unknown>) =>
  (payload.messages as Array<Wire>).flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? m.content.flatMap((b) =>
          b.type === "thinking" ? [String(b.signature)] : b.type === "redacted_thinking" ? [String(b.data)] : []
        )
      : []
  )

/** A run of `turns` signed tool turns, each request let through the binding as the app does. */
const run = (turns: number, redactedAt = -1) => {
  const c = start()
  for (let i = 0; i < turns; i++) {
    const bound = bind(c)
    expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
    answer(c, bound.payload, i === redactedAt)
  }
  return c
}

describe("signed thinking when nothing changed", () => {
  it("sends every block back, byte for byte, and the provider accepts it", () => {
    const c = run(3, 1)
    const payload = payloadOf(c)
    const bound = bind(c, payload)
    expect(bound.dropped).toBe(0)
    expect(bound.payload).toBe(payload)
    expect(signed(bound.payload)).toHaveLength(3)
    expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
  })

  it("leaves a payload without signed blocks untouched", () => {
    const c = start()
    const payload = payloadOf(c)
    expect(bind(c, payload)).toEqual({ payload, dropped: 0, reason: null })
  })

  it("ignores cache markers at documented positions", () => {
    const c = run(2)
    const payload = payloadOf(c)
    const moved = {
      ...payload,
      tools: c.tools,
      messages: (payload.messages as Array<Wire>).map((m, i) =>
        i === 2
          ? {
              ...m,
              content: (m.content as Array<Record<string, unknown>>).map(
                ({ cache_control: _marker, ...block }) => block
              )
            }
          : m
      )
    }
    const bound = bind(c, moved)
    expect(bound.dropped).toBe(0)
    expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
  })
})

/** Each change to what came before, as the next request's bytes show it. */
const changes: ReadonlyArray<readonly [string, (c: Conversation) => void, number]> = [
  // [name, the change, how many of the three blocks survive (a leading run)]
  ["an edit of an earlier message", (c) => (c.wire[0] = { role: "user", content: "Mira runs up the stairs." }), 0],
  ["a deletion of an earlier message", (c) => c.wire.splice(0, 2), 0],
  [
    "a message inserted earlier",
    (c) =>
      c.wire.splice(1, 0, { role: "user", content: "(A gull cries.)" }, { role: "assistant", content: "It circles." }),
    0
  ],
  ["an earlier message hidden from the model", (c) => c.wire.splice(1, 1), 0],
  [
    "another swipe chosen on an earlier message",
    (c) => (c.wire[1] = { role: "assistant", content: [{ type: "text", text: "The lamp holds steady." }] }),
    0
  ],
  ["a branch whose earlier messages differ", (c) => (c.wire[0] = { role: "user", content: "Mira waits below." }), 0],
  [
    "another chat merged in before it",
    (c) =>
      c.wire.splice(
        0,
        0,
        { role: "user", content: "[Merged: the harbour]" },
        { role: "assistant", content: "Boats rock." }
      ),
    0
  ],
  ["a presence correction that changes the system prompt", (c) => (c.system += " Ansel is away."), 0],
  [
    "a preset or regex change that rewrites earlier text",
    (c) => (c.wire[1] = { role: "assistant", content: [{ type: "text", text: "The lamp flickers!" }] }),
    0
  ],
  [
    "a summary standing in for earlier messages",
    (c) => c.wire.splice(0, 2, { role: "user", content: "[Summary: Mira reached the lamp room.]" }),
    0
  ],
  [
    "a note moved to another turn",
    (c) => {
      c.wire[0] = { role: "user", content: "[Note: it is night.] Mira climbs the stairs." }
    },
    0
  ],
  ["the tools offered changing (the turn cap's request)", (c) => (c.tools.length = 0), 0],
  // A change after the second block: the first two still stand (a leading run).
  [
    "an edited tool result after the second turn",
    (c) => {
      c.wire[c.wire.length - 3] = {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "Changed." }]
      }
    },
    2
  ]
]

describe("signed thinking after the history before it changed", () => {
  for (const [name, change, survive] of changes)
    it(`${name}: drops the blocks from the change on, and the provider accepts the request`, () => {
      const c = run(3)
      change(c)
      const bound = bind(c)
      expect(signed(bound.payload)).toEqual(signed(payloadOf(c)).slice(0, survive))
      expect(bound.dropped).toBe(3 - survive)
      expect(bound.reason).toBe("changed")
      expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
      // The checker would refuse what the app had before this fix: the same request with the blocks.
      expect(verify(payloadOf(c) as unknown as AnthropicBody, c.issued).ok).toBe(false)
      // Reply text, tool calls and results stay.
      const calls = (p: Record<string, unknown>) =>
        JSON.stringify(p.messages).match(/"tool_use"|"tool_result"/g)?.length ?? 0
      expect(calls(bound.payload)).toBe(calls(payloadOf(c)))
    })

  it("thinking alone is not part of later blocks’ prefix", () => {
    const c = run(3)
    // The middle turn's thinking taken out of the transcript and the wire, as hiding does.
    const turn = c.wire[5] as { content: Array<{ type: string }> }
    turn.content = turn.content.filter((b) => b.type !== "thinking")
    const bound = bind(c)
    expect(signed(bound.payload)).toEqual(signed(payloadOf(c)))
    expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
    expect(verify(payloadOf(c) as unknown as AnthropicBody, c.issued).ok).toBe(true)
  })

  it("thinking another model or connection wrote is left out, with its own reason", () => {
    const c = run(2)
    const bound = bind(c, payloadOf(c), { connectionId: "conn-b", modelId: "model-a" })
    expect(signed(bound.payload)).toEqual([])
    expect(bound.reason).toBe("model")
  })

  it("a block the app has no record of is never sent", () => {
    const c = run(2)
    const bound = bindThinking(anthropicBinding, payloadOf(c), { context: [], ...written, mode: "check" })
    expect(signed(bound.payload)).toEqual([])
  })

  it("strip leaves every block out; keep sends them as they are", () => {
    const c = run(2)
    expect(signed(bind(c, payloadOf(c), written, "strip").payload)).toEqual([])
    c.system = "Changed."
    expect(signed(bind(c, payloadOf(c), written, "keep").payload)).toHaveLength(2)
  })

  it("a turn left with nothing but thinking is taken out whole", () => {
    const c = run(1)
    ;(c.wire[3] as { content: Array<{ type: string }> }).content = (
      c.wire[3] as { content: Array<{ type: string }> }
    ).content.filter((b) => b.type !== "tool_use")
    c.system = "Changed."
    const bound = bind(c)
    expect(
      (bound.payload.messages as Array<Wire>).some((m) => Array.isArray(m.content) && m.content.length === 0)
    ).toBe(false)
  })
})

// Tool loading (spec/TOOL-LOADING.md): what each mode does to the tools across a run, and so to
// the thinking bound to them. Every tool up front and the dispatcher send one list all run; the
// native Anthropic wire declares deferred tools on every request and loads them by reference.
describe("signed thinking and tool loading", () => {
  it("native deferred loading keeps the tools the same, so every block goes back", () => {
    const c = start()
    const deferred = [{ name: "search_chat", description: "search_chat tool", parameters: { type: "object" } }]
    const loads: Array<{ toolCallId: string; names: Array<string> }> = []
    for (let turn = 0; turn < 3; turn++) {
      const payload = applyAnthropicToolLoading(structuredClone(payloadOf(c)), {
        api: "anthropic-messages",
        deferred,
        loads
      })
      const bound = bind(c, payload)
      expect(bound.dropped).toBe(0)
      expect(signed(bound.payload)).toHaveLength(turn)
      expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
      answer(c, bound.payload)
      // The first call loads the deferred tool: later requests reference it in that result.
      if (turn === 0) loads.push({ toolCallId: `call-${n}`, names: ["search_chat"] })
    }
  })

  it("a mode that grew the tools mid-run would drop the earlier blocks, and the provider accepts that", () => {
    const c = run(2)
    c.tools.push(tool("note_down"))
    const bound = bind(c)
    expect(signed(bound.payload)).toEqual([])
    expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
    expect(verify(payloadOf(c) as unknown as AnthropicBody, c.issued).ok).toBe(false)
  })

  it("a tool's description edited counts as a change", () => {
    const c = run(1)
    c.tools[0] = { ...c.tools[0]!, description: "Looks up a detail." }
    expect(signed(bind(c).payload)).toEqual([])
  })
})

describe("refusals", () => {
  const error = (message: string, status = 400) => ({ status, message, afterTokens: false })
  it("recognizes the provider's refusal of signed thinking", () => {
    expect(
      refusesSigned(
        error(
          "messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."
        )
      )
    ).toBe(true)
    // As measured on the API (live-thinking report, 2026-11-14), with the reason after it.
    expect(
      refusesSigned(
        error(
          'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. The `tools` list differs from the one this block was created with.'
        )
      )
    ).toBe(true)
    expect(refusesSigned(error("messages.1.content.0: Invalid `signature` in `redacted_thinking` block."))).toBe(false)
    expect(refusesSigned(error("Overloaded", 529))).toBe(false)
    expect(refusesSigned(error("prompt is too long"))).toBe(false)
  })
})

describe("Claude through OpenRouter", () => {
  const details = (sig: string) => [
    { type: "reasoning.text", text: "Plan.", signature: sig, format: "anthropic-claude-v1" }
  ]
  const routed = (turns: ReadonlyArray<string>, system = "Narrate.") => ({
    model: "anthropic/claude-test",
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Who keeps the light?" },
      ...turns.flatMap((sig, i) => [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `c${i}`, type: "function", function: { name: "look_up", arguments: "{}" } }],
          reasoning_details: details(sig)
        },
        { role: "tool", tool_call_id: `c${i}`, content: "Ansel." }
      ])
    ]
  })
  const pi = (sig: string, record: ThinkingRecord) =>
    ({
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "anthropic/claude-test",
      usage,
      stopReason: "toolUse",
      timestamp: 0,
      content: [{ type: "thinking", thinking: "Plan.", thinkingSignature: JSON.stringify(details(sig)) }],
      thinkingRecord: record
    }) as unknown as AssistantMessage

  it("applies only to Claude models there", () => {
    expect(
      openRouterClaudeBinding.appliesTo({
        kind: "openrouter",
        api: "openai-completions",
        model: "anthropic/claude-test"
      })
    ).toBe(true)
    expect(
      openRouterClaudeBinding.appliesTo({ kind: "openrouter", api: "openai-completions", model: "google/gemini-4" })
    ).toBe(false)
  })

  it("keeps the details while nothing changed, and drops them and the reasoning text after a change", () => {
    const first = routed([])
    const record = thinkingRecord(openRouterClaudeBinding, first, written)
    const context = [pi("s1", record)]
    const same = bindThinking(openRouterClaudeBinding, routed(["s1"]), { context, ...written, mode: "check" })
    expect(same.dropped).toBe(0)
    const changed = bindThinking(openRouterClaudeBinding, routed(["s1"], "Narrate differently."), {
      context,
      ...written,
      mode: "check"
    })
    expect(changed.dropped).toBe(1)
    expect(JSON.stringify(changed.payload)).not.toContain("reasoning_details")
    expect(JSON.stringify(changed.payload)).toContain("tool_calls")
  })
})

describe("review: binding compares actual content", () => {
  it("does not ignore a tool argument named cache_control", () => {
    const c = run(1)
    const turn = c.wire[3] as { content: Array<Record<string, unknown>> }
    // First bind a third block to a transcript containing the original value.
    turn.content[1]!.input = { cache_control: "original" }
    answer(c, payloadOf(c))
    turn.content[1]!.input = { cache_control: "changed" }
    expect(signed(bind(c).payload)).toHaveLength(1)
  })

  it("does not assume a reordered tools array has the same binding", () => {
    const c = run(1)
    c.tools.reverse()
    expect(bind(c).dropped).toBe(1)
  })

  it("does not retry an unrelated signature validation error", () => {
    expect(refusesSigned({ status: 400, message: "Invalid signature in thinking block.", afterTokens: false })).toBe(
      false
    )
    expect(
      refusesSigned({
        status: 400,
        message: "A tool described as bound to a different conversation is invalid.",
        afterTokens: false
      })
    ).toBe(false)
  })
})

describe("review: encrypted Responses reasoning", () => {
  const item = (id: string) => ({ type: "reasoning", id, encrypted_content: id, summary: [] })
  const base = {
    model: "gpt-test",
    tools: [{ type: "function", name: "lookup" }],
    input: [{ role: "user", content: "Hello" }]
  }
  const pi = (items: Array<unknown>, record: ThinkingRecord) =>
    ({
      role: "assistant",
      content: items.map((i) => ({ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(i) })),
      thinkingRecord: record
    }) as unknown as AssistantMessage
  it("keeps unchanged items and strips only from the first differing prefix", () => {
    const first = item("first")
    const text = { type: "message", role: "assistant", content: [{ type: "output_text", text: "A" }] }
    const second = item("second")
    const record = thinkingRecord(responsesBinding, base, written, [first, text, second])
    const payload = { ...base, input: [...base.input, first, text, second] }
    const context = [pi([first, second], record)]
    expect(bindThinking(responsesBinding, payload, { context, ...written, mode: "check" }).payload).toBe(payload)
    const edited = {
      ...payload,
      input: [...base.input, first, { ...text, content: [{ type: "output_text", text: "B" }] }, second]
    }
    const bound = bindThinking(responsesBinding, edited, { context, ...written, mode: "check" })
    expect(bound.dropped).toBe(1)
    expect(bound.payload.input).toEqual(edited.input.slice(0, -1))
    for (const changed of [
      { tools: [] },
      { instructions: "New" },
      { reasoning: { effort: "low" } },
      { text: { format: { type: "json_object" } } }
    ]) {
      expect(
        bindThinking(responsesBinding, { ...payload, ...changed }, { context, ...written, mode: "check" }).dropped
      ).toBe(2)
    }
  })
})

it("review: an edited manual-thinking tool turn disables thinking before dispatch", () => {
  const c = run(1)
  c.system = "Changed"
  const bound = bind(c, { ...payloadOf(c), thinking: { type: "enabled", budget_tokens: 1500 } })
  expect(bound.payload.thinking).toEqual({ type: "disabled" })
  expect(signed(bound.payload)).toEqual([])
})

it("review: changing transport identity under the same connection id drops blocks", () => {
  const c = run(1)
  const bound = bindThinking(anthropicBinding, payloadOf(c), {
    context: c.pi,
    ...written,
    connectionStamp: "different endpoint",
    mode: "check"
  })
  expect(bound.dropped).toBe(1)
  expect(bound.reason).toBe("model")
})

it("review: the fake reports the first differing position", () => {
  const c = run(2)
  c.wire[0] = { role: "user", content: "Changed" }
  const verdict = verify(payloadOf(c) as unknown as AnthropicBody, c.issued)
  expect(verdict.ok).toBe(false)
  if (!verdict.ok) expect(verdict.message).toContain("first at messages.0.content")
})

it("review: an edit between two thinking blocks drops only the later block", () => {
  const c = start()
  const before = payloadOf(c)
  const wire = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "First", signature: "first" },
      { type: "text", text: "Progress" },
      { type: "thinking", thinking: "Second", signature: "second" },
      { type: "text", text: "Done" }
    ]
  }
  const source = structuredClone(before) as unknown as AnthropicBody
  c.issued.set("first", { prefix: prefixOf(source, source.messages.length), prev: null, source })
  const within = [{ type: "text", text: "Progress" }]
  c.issued.set("second", { prefix: prefixOf(source, source.messages.length, within), prev: "first", source, within })
  const record = thinkingRecord(anthropicBinding, before, written, [wire])
  const context = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "First", thinkingSignature: "first" },
        { type: "thinking", thinking: "Second", thinkingSignature: "second" }
      ],
      thinkingRecord: record
    }
  ] as unknown as Array<Message>
  const payload = { ...before, messages: [...c.wire, wire] }
  expect(bindThinking(anthropicBinding, payload, { ...written, context, mode: "check", run: true }).payload).toBe(
    payload
  )
  wire.content[1]!.text = "Edited progress"
  const bound = bindThinking(anthropicBinding, payload, { ...written, context, mode: "check" })
  expect(verify(payload as unknown as AnthropicBody, c.issued).ok).toBe(false)
  expect(verify(bound.payload as unknown as AnthropicBody, c.issued).ok).toBe(true)
  expect(bound.dropped).toBe(1)
  expect(signed(bound.payload)).toEqual(["first"])
  expect(JSON.stringify(bound.payload)).toContain("Edited progress")
})

it("review: signed-binding retries never follow output or another HTTP status", () => {
  const message = "Invalid `signature` in `thinking` block. The block is bound to a different conversation."
  expect(refusesSigned({ status: 400, message, afterTokens: true })).toBe(false)
  expect(refusesSigned({ status: 500, message, afterTokens: false })).toBe(false)
})

it("review: manual thinking hide waits for the active tool turn, adaptive replay omits it", () => {
  const c = run(1)
  const transcript = [{ role: "rpRequest", timestamp: 0 }, ...c.pi] as Array<
    import("@earendil-works/pi-agent-core").AgentMessage
  >
  expect(anthropicBinding.deferHiddenThinking?.("claude-haiku-4-5")).toBe(true)
  expect(anthropicBinding.deferHiddenThinking?.("claude-opus-4-8")).toBe(false)
  const manual = withoutThinking(transcript, 0, true)
  const adaptive = withoutThinking(transcript)
  const wire = (messages: typeof transcript) =>
    messages.flatMap((m) => (m.role === "assistant" ? anthropicBinding.reply!(m, {} as never) : []))
  expect(JSON.stringify(wire(manual))).toContain("signature")
  expect(JSON.stringify(wire(adaptive))).not.toContain("signature")
  expect(JSON.stringify(wire(adaptive))).toContain("tool_use")
})

it("review: Claude reasoning details are guarded on Chat Completions proxies too", () => {
  expect(
    openRouterClaudeBinding.appliesTo({ kind: "openai-chat", api: "openai-completions", model: "claude-fable-5-2" })
  ).toBe(true)
})

it("review: shape and nested key-order changes cannot conceal a modified prefix", () => {
  const c = run(1)
  c.wire[0] = { role: "user", content: [{ type: "text", text: "Mira climbs the stairs." }] }
  expect(bind(c).dropped).toBe(1)
  const d = run(1)
  const tool = d.tools[0]!
  d.tools[0] = { input_schema: tool.input_schema, description: tool.description, name: tool.name }
  expect(bind(d).dropped).toBe(1)
})

it("review: the refusal retry removes unsigned thinking blocks too", () => {
  const c = run(1)
  c.wire.push({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Unsigned" },
      { type: "text", text: "Keep this" }
    ]
  })
  const result = bind(c, payloadOf(c), written, "strip")
  expect(JSON.stringify(result.payload)).not.toContain('"type":"thinking"')
  expect(JSON.stringify(result.payload)).toContain("Keep this")
})

it("review: routed Claude cache markers do not change a reasoning prefix", () => {
  const details = [{ type: "reasoning.encrypted", data: "synthetic-router", format: "anthropic-claude-v1" }]
  const first = {
    model: "anthropic/claude-synthetic",
    messages: [
      { role: "system", content: [{ type: "text", text: "Narrate", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] }
    ]
  }
  const record = thinkingRecord(openRouterClaudeBinding, first, written)
  const context = [
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(details) }],
      thinkingRecord: record
    }
  ] as unknown as Array<Message>
  const moved = {
    ...first,
    messages: [
      { role: "system", content: [{ type: "text", text: "Narrate" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: "Answer", reasoning_details: details }
    ]
  }
  expect(bindThinking(openRouterClaudeBinding, moved, { ...written, context, mode: "check" }).dropped).toBe(0)
})

it("review: Bedrock Responses checkpoints do not change a reasoning prefix", () => {
  const first = {
    model: "gpt-synthetic",
    input: [
      { role: "user", content: [{ type: "input_text", text: "Hello", prompt_cache_breakpoint: { mode: "explicit" } }] }
    ]
  }
  const item = { type: "reasoning", encrypted_content: "synthetic-response", id: "rs_one", summary: [] }
  const record = thinkingRecord(responsesBinding, first, written)
  const context = [
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) }],
      thinkingRecord: record
    }
  ] as unknown as Array<Message>
  const moved = { ...first, input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }, item] }
  expect(bindThinking(responsesBinding, moved, { ...written, context, mode: "check" }).dropped).toBe(0)
})
