import { describe, expect, it } from "vitest"
import { googleRequest } from "../src/providers/googleRequest.ts"
import { outputLimiters } from "../src/providers/outputLimit.ts"

describe("final provider output ceilings", () => {
  it.each([
    ["openai-completions", { max_tokens: 200, n: 8 }, { max_tokens: 7, n: 1 }],
    [
      "openai-completions",
      { max_completion_tokens: 200, max_tokens: 3 },
      { max_completion_tokens: 7, max_tokens: 3, n: 1 }
    ],
    ["openai-responses", { max_output_tokens: 200 }, { max_output_tokens: 7 }],
    ["anthropic-messages", { max_tokens: 200 }, { max_tokens: 7 }],
    [
      "google-generative-ai",
      { config: { maxOutputTokens: 200, candidateCount: 8 } },
      { config: { maxOutputTokens: 7, candidateCount: 1 } }
    ]
  ])("caps %s after preset fields without increasing smaller limits", (api, payload, expected) => {
    const original = JSON.stringify(payload)
    expect(outputLimiters[api as string]!(payload as Record<string, unknown>, 7)).toEqual(expected)
    expect(JSON.stringify(payload)).toBe(original)
  })
  it("the Google SDK-shaped ceiling reaches the REST request", () => {
    const limited = outputLimiters["google-generative-ai"]!(
      {
        model: "gemini-test",
        contents: [{ role: "user", parts: [{ text: "Synthetic." }] }],
        config: { maxOutputTokens: 300 }
      },
      4
    )
    expect(googleRequest(limited).body).toMatchObject({ generationConfig: { maxOutputTokens: 4, candidateCount: 1 } })
  })
})
