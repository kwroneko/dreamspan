// Signed thinking on the wire (ARCHITECTURE §6 "Signed thinking"): every way the history before
// a signed block can change, as the request bytes show it, against a checker that enforces the
// provider's documented rule (support/enforcingAnthropic.ts). (a) The blocks are absent after a
// change and present without one; (b) every request the binding lets through passes the check.
import { describe, expect, it } from "vitest"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import {
  anthropicBinding,
  bindThinking,
  needsSigned,
  openRouterClaudeBinding,
  refusesSigned,
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
  c.issued.set(signature, { prefix: prefixOf(body, body.messages.length), prev })
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

  it("ignores where the cache markers are and the order of the tools", () => {
    const c = run(2)
    const payload = payloadOf(c)
    const moved = {
      ...payload,
      tools: [...c.tools].reverse(),
      messages: (payload.messages as Array<Wire>).map((m, i) =>
        i === 0
          ? {
              role: m.role,
              content: [{ type: "text", text: "Mira climbs the stairs.", cache_control: { type: "ephemeral" } }]
            }
          : m
      )
    }
    // A string and a one-text-block content are the same message to the provider.
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

  it("a block left out of the middle (hidden thinking) drops every block after it too", () => {
    const c = run(3)
    // The middle turn's thinking taken out of the transcript and the wire, as hiding does.
    const turn = c.wire[5] as { content: Array<{ type: string }> }
    turn.content = turn.content.filter((b) => b.type !== "thinking")
    const bound = bind(c)
    expect(signed(bound.payload)).toEqual(signed(payloadOf(c)).slice(0, 1))
    expect(verify(bound.payload as unknown as AnthropicBody, c.issued)).toEqual({ ok: true })
    expect(verify(payloadOf(c) as unknown as AnthropicBody, c.issued).ok).toBe(false)
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
    expect(refusesSigned(error("messages.1.content.0: Invalid `signature` in `redacted_thinking` block."))).toBe(true)
    expect(refusesSigned(error("Overloaded", 529))).toBe(false)
    expect(refusesSigned(error("prompt is too long"))).toBe(false)
  })
  it("recognizes an older model's demand for the turn's thinking", () => {
    expect(
      needsSigned(error("messages.3.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`."))
    ).toBe(true)
    expect(needsSigned(error("Invalid `signature` in `thinking` block."))).toBe(false)
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
