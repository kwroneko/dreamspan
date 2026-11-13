// A run's suffix on the wire when it goes on (spec/AGENTIC.md §12.3): on the same model, and on
// another one, with DeepSeek's documented rule that a replayed tool-call turn in thinking mode
// carries `reasoning_content` (a 400 otherwise). Synthetic; no provider is contacted.
import { describe, expect, it } from "vitest"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import type { ProviderRequest } from "../src/assembler/wire.ts"
import { forTarget, rolloutRequest } from "../src/agent/wire.ts"

const prefix = {
  context: { messages: [{ role: "user", content: "Who keeps the lighthouse?", timestamp: 0 }] },
  payload: { model: "m", messages: [{ role: "user", content: "Who keeps the lighthouse?" }] },
  breakpoints: []
} as unknown as ProviderRequest

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
const callTurn = (
  from: { api: string; provider: string; model: string },
  thinking?: { text: string; signature?: string }
): AssistantMessage =>
  ({
    role: "assistant",
    api: from.api,
    provider: from.provider,
    model: from.model,
    usage,
    stopReason: "toolUse",
    timestamp: 0,
    content: [
      ...(thinking
        ? [
            {
              type: "thinking",
              thinking: thinking.text,
              ...(thinking.signature ? { thinkingSignature: thinking.signature } : {})
            }
          ]
        : []),
      { type: "toolCall", id: "call_1", name: "look_up", arguments: { topic: "keeper" } }
    ]
  }) as AssistantMessage
const result: Message = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "look_up",
  content: [{ type: "text", text: "keeper: the keeper is Ansel." }],
  isError: false,
  timestamp: 0
}

const deepseek = { api: "openai-completions", kind: "deepseek", key: "deepseek-flash" } as const
const deepseekWrote = { api: "openai-completions", provider: "deepseek", model: "deepseek-flash" }
const claudeWrote = { api: "anthropic-messages", provider: "anthropic", model: "claude-test" }

/** The suffix's assistant message as sent to `target` over Chat Completions. */
const sentTurn = (turn: AssistantMessage, target: { api: string; kind: string; key: string }) => {
  const suffix = forTarget([turn, result], target as never)
  const wire = rolloutRequest(prefix, target.api, suffix, undefined, {
    replayReasoning: true,
    reasoningTarget: target as never
  })
  return (wire.payload.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!
}

describe("a resumed run's suffix on DeepSeek", () => {
  it("on the same model, keeps the call turn's own reasoning_content", () => {
    const sent = sentTurn(callTurn(deepseekWrote, { text: "Check the log.", signature: "reasoning_content" }), deepseek)
    expect(sent.reasoning_content).toBe("Check the log.")
    expect(sent.tool_calls).toHaveLength(1)
  })

  it("switched to from another model, sends an empty reasoning_content and none of the other model's thinking", () => {
    const sent = sentTurn(callTurn(claudeWrote, { text: "Private plan.", signature: "c2lnbmVk" }), deepseek)
    expect(sent.reasoning_content).toBe("")
    expect(JSON.stringify(sent)).not.toContain("Private plan.")
    expect(sent.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "look_up", arguments: '{"topic":"keeper"}' } }
    ])
  })

  it("switched to from a model that wrote no thinking, sends an empty reasoning_content", () => {
    expect(sentTurn(callTurn(claudeWrote), deepseek).reasoning_content).toBe("")
  })

  it("leaves other Chat Completions providers without a reasoning field", () => {
    const sent = sentTurn(callTurn(claudeWrote), { api: "openai-completions", kind: "openai-chat", key: "gpt-test" })
    expect(sent).not.toHaveProperty("reasoning_content")
  })
})

describe("forTarget", () => {
  it("keeps the registered provider's own signatures when its kind has a different name", () => {
    const turn = callTurn(
      { api: "anthropic-messages", provider: "amazon-bedrock", model: "claude-test" },
      { text: "Plan.", signature: "signed" }
    )
    expect(forTarget([turn], { api: "anthropic-messages", key: "claude-test", provider: "amazon-bedrock" })[0]).toBe(
      turn
    )
  })
  it("drops thinking and signatures on a provider switch even when the API and model key match", () => {
    const turn = callTurn(
      { api: "openai-completions", provider: "openrouter", model: "shared-key" },
      { text: "Private plan.", signature: '[{"type":"reasoning.encrypted","data":"opaque"}]' }
    )
    const [converted] = forTarget([turn], {
      api: "openai-completions",
      key: "shared-key",
      provider: "deepseek"
    } as never) as [AssistantMessage]
    expect(converted.content).toEqual([
      { type: "toolCall", id: "call_1", name: "look_up", arguments: { topic: "keeper" } }
    ])
  })

  it("drops another model's thinking and call signatures, and keeps the same model's", () => {
    const signed = {
      ...callTurn(claudeWrote, { text: "Plan.", signature: "sig" }),
      content: [
        { type: "thinking", thinking: "Plan.", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_1", name: "look_up", arguments: { topic: "keeper" }, thoughtSignature: "t" }
      ]
    } as AssistantMessage
    const [other] = forTarget([signed], { api: "openai-completions", key: "deepseek-flash" }) as [AssistantMessage]
    expect(other.content).toEqual([{ type: "toolCall", id: "call_1", name: "look_up", arguments: { topic: "keeper" } }])
    const [same] = forTarget([signed], { api: "anthropic-messages", key: "claude-test" })
    expect(same).toBe(signed)
  })
})
