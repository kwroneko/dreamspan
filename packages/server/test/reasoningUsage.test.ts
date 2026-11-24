// A reply's reasoning count from each provider's usage shape (reasoningstats1): the provider's own
// count where its usage has one, the app's count of the thinking text where it doesn't (Anthropic),
// what the output leaves after the reply when the thinking was hidden, and none.
import { assert, describe, it } from "@effect/vitest"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { emptyCapture, reasoningPlan, reportedReasoning, resolveReasoning } from "../src/providers/usage.ts"

const message = (api: string, content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  api,
  provider: "synthetic",
  model: "synthetic",
  timestamp: 0,
  stopReason: "stop",
  content,
  usage: {
    input: 10,
    output: 778,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 788,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
})
const captured = (rawUsage: Record<string, unknown>) => ({ ...emptyCapture(), rawUsage })
const reply = { type: "text" as const, text: "Mira opens the door." }
const thinking = { type: "thinking" as const, thinking: "She would hesitate first." }

describe("reasoning counts per provider usage", () => {
  it("OpenAI Chat Completions: completion_tokens_details.reasoning_tokens", () => {
    const raw = { prompt_tokens: 10, completion_tokens: 778, completion_tokens_details: { reasoning_tokens: 512 } }
    const plan = reasoningPlan(message("openai-completions", [reply]), captured(raw), "reported")
    assert.deepStrictEqual(plan, { kind: "reported", tokens: 512 })
    assert.deepStrictEqual(resolveReasoning(plan, 778, null), { reasoning: 512, estimated: false })
  })

  it("OpenRouter: the same field, with streamed reasoning text beside it", () => {
    const raw = {
      prompt_tokens: 10,
      completion_tokens: 778,
      cost: 0.001,
      completion_tokens_details: { reasoning_tokens: 300 }
    }
    const plan = reasoningPlan(message("openai-completions", [thinking, reply]), captured(raw), "reported")
    assert.deepStrictEqual(resolveReasoning(plan, 778, null), { reasoning: 300, estimated: false })
  })

  it("OpenAI Responses: output_tokens_details.reasoning_tokens", () => {
    assert.equal(reportedReasoning({ output_tokens: 778, output_tokens_details: { reasoning_tokens: 64 } }), 64)
  })

  it("Gemini: thoughtsTokenCount; absent with no thoughts is none", () => {
    const raw = { promptTokenCount: 10, candidatesTokenCount: 266, thoughtsTokenCount: 512 }
    const plan = reasoningPlan(message("google-generative-ai", [reply]), captured(raw), "reported")
    assert.deepStrictEqual(resolveReasoning(plan, 778, null), { reasoning: 512, estimated: false })
    const none = reasoningPlan(
      message("google-generative-ai", [reply]),
      captured({ promptTokenCount: 10, candidatesTokenCount: 266 }),
      "reported"
    )
    assert.deepStrictEqual(resolveReasoning(none, 266, null), { reasoning: 0, estimated: false })
  })

  it("Anthropic: no count, so the thinking text is counted here and marked an estimate", () => {
    const raw = { input_tokens: 10, output_tokens: 778 }
    const plan = reasoningPlan(message("anthropic-messages", [thinking, reply]), captured(raw), "reported")
    assert.deepStrictEqual(plan, { kind: "thinking", text: "She would hesitate first." })
    assert.deepStrictEqual(resolveReasoning(plan, 778, 7), { reasoning: 7, estimated: true })
    // An estimate never exceeds the output it's part of.
    assert.deepStrictEqual(resolveReasoning(plan, 5, 7), { reasoning: 5, estimated: true })
  })

  it("Anthropic with the thinking hidden: the output less the reply, an estimate", () => {
    const omitted = { type: "thinking" as const, thinking: "", thinkingSignature: "sig" }
    const plan = reasoningPlan(
      message("anthropic-messages", [omitted, reply]),
      captured({ input_tokens: 10, output_tokens: 778 }),
      "reported"
    )
    assert.deepStrictEqual(plan, { kind: "rest", reply: "Mira opens the door." })
    assert.deepStrictEqual(resolveReasoning(plan, 778, 6), { reasoning: 772, estimated: true })
  })

  it("leaves hidden thinking unknown when ordinary tool output contributes to the reported total", () => {
    const omitted = { type: "thinking" as const, thinking: "", thinkingSignature: "sig" }
    const tool = { type: "toolCall" as const, id: "call", name: "search", arguments: { query: "river crossing" } }
    const raw = { input_tokens: 10, output_tokens: 50 }
    const plan = reasoningPlan(message("anthropic-messages", [omitted, tool]), captured(raw), "reported")
    assert.deepStrictEqual(resolveReasoning(plan, 50, 0), { reasoning: null, estimated: false })
  })

  it("none: no thinking and no count is no reasoning; no usage at all is unknown", () => {
    const plan = reasoningPlan(
      message("openai-completions", [reply]),
      captured({ prompt_tokens: 10, completion_tokens: 6 }),
      "reported"
    )
    assert.deepStrictEqual(resolveReasoning(plan, 6, null), { reasoning: 0, estimated: false })
    assert.deepStrictEqual(
      resolveReasoning(reasoningPlan(message("anthropic-messages", []), emptyCapture(), "none"), null, null),
      { reasoning: null, estimated: false }
    )
  })
})
