import { assert, it } from "@effect/vitest"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { captureUsageHeaders, emptyCapture, finalCounts } from "../src/providers/usage.ts"

for (const stopReason of ["toolUse", "aborted", "error"] as const)
  it(`retains the reported Fireworks header when ${stopReason} has no text or body usage`, () => {
    const capture = emptyCapture()
    captureUsageHeaders(new Headers({ "fireworks-cached-prompt-tokens": "100" }), capture)
    const message: AssistantMessage = {
      role: "assistant",
      api: "openai-completions",
      provider: "fireworks",
      model: "synthetic",
      timestamp: 0,
      stopReason,
      content: [{ type: "toolCall", name: "lookup", id: "synthetic", arguments: {} }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    }
    const result = finalCounts(message, capture, [])
    assert.equal(result.counts.cacheRead, 100)
    assert.isNull(result.counts.inputUncached)
    assert.isNull(result.counts.output)
    assert.equal(result.source, "reported")
  })

for (const stopReason of ["toolUse", "aborted", "error"] as const)
  it(`estimates schema-generated prose without provider usage after ${stopReason}`, () => {
    const message: AssistantMessage = {
      role: "assistant",
      api: "openai-completions",
      provider: "openai",
      model: "synthetic",
      timestamp: 0,
      stopReason,
      content: [
        { type: "toolCall", name: "continue_reply", id: "reply", arguments: { text: "Prefix. Added suffix." } }
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    }
    const result = finalCounts(message, emptyCapture(), [], "continue_reply")
    assert.equal(result.source, "estimated")
    assert.isAbove(result.counts.output ?? 0, 0)
    // A real tool call still has the existing unknown-usage semantics.
    assert.equal(finalCounts(message, emptyCapture(), []).source, "none")
  })
