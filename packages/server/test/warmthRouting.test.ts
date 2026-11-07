// The cache estimate treats an OpenRouter routing change as a new provider's cache (liveapi2:
// pinned from Anthropic to Vertex, the next request read nothing). Synthetic snapshots.
import { assert, describe, it } from "@effect/vitest"
import { prefixChange } from "../src/assembler/warmth.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"

const snapshot = (kind: string, routing: Record<string, unknown> | undefined) => {
  const messages = [
    { role: "system", content: "Archive entries about the harbor." },
    { role: "user", content: "Good evening, Mira." }
  ]
  return {
    request: { messages, breakpoints: [{ message: 1 }] },
    inputs: {
      model: {
        connectionId: "connection",
        modelId: "model",
        key: "anthropic/claude-haiku-4.5",
        api: "openai-completions",
        kind,
        connectionRevision: 0,
        settings: routing ? { routing } : {}
      }
    },
    wire: { messages: messages.map((m, i) => ({ ...m, inputs: [i] })) }
  } as unknown as ContextSnapshot
}

const describeSource = () => ({ label: "Message" })

describe("cache estimate and provider routing", () => {
  it("says the prefix changed when OpenRouter's routing changes", () => {
    const anthropic = snapshot("openrouter", { only: ["anthropic"], allow_fallbacks: false })
    const vertex = snapshot("openrouter", { only: ["google-vertex"], allow_fallbacks: false })
    assert.isNull(
      prefixChange(anthropic, snapshot("openrouter", { allow_fallbacks: false, only: ["anthropic"] }), describeSource)
    )
    const changed = prefixChange(anthropic, vertex, describeSource)
    assert.match(changed?.reason ?? "", /provider routing changed/)
    assert.isAbove(changed!.tokens, 0)
    assert.match(prefixChange(snapshot("openrouter", undefined), vertex, describeSource)?.reason ?? "", /routing/)
  })

  it("ignores routing settings on other kinds, which don't send them", () => {
    assert.isNull(
      prefixChange(snapshot("anthropic", { only: ["a"] }), snapshot("anthropic", { only: ["b"] }), describeSource)
    )
  })
})
