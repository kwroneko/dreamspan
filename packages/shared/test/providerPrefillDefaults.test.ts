import { describe, expect, it } from "vitest"
import { resolveModel } from "../src/providers.ts"

const dialect = (kind: string, api: string, key: string, provider = "openai-compatible") =>
  resolveModel(key, {}, {}, {}, {}, { kind, api, provider }).prefill.value

describe("prefill without an unmeasured model exclusion", () => {
  for (const [kind, api, key, expected] of [
    ["openai-chat", "openai-completions", "museum-gpt", "tool_schema"],
    ["openai-responses", "openai-responses", "ft:gpt-5.6-sol:synthetic::deployment", "tool_schema"],
    ["openai-responses-bedrock", "openai-responses", "global.openai.gpt-5.6-sol", "tool_schema"],
    ["anthropic", "anthropic-messages", "museum-claude", "assistant"],
    ["anthropic", "anthropic-messages", "claude-sonnet-4-7", "assistant"],
    ["anthropic-bedrock", "anthropic-messages", "global.anthropic.claude-sonnet-4-7-v1:0", "assistant"],
    ["openrouter", "openai-completions", "anthropic/claude-opus-4.7", "assistant"]
  ] as const)
    it(`${kind} ${key} defaults to ${expected}`, () => expect(dialect(kind, api, key)).toBe(expected))

  it("keeps the recorded direct and routed Claude refusals, and explicit None", () => {
    for (const key of ["claude-sonnet-4-6", "claude-haiku-5-5", "claude-sonnet-5", "claude-fable-5-2"])
      expect(dialect("anthropic", "anthropic-messages", key, "anthropic"), key).toBe("none")
    expect(dialect("openrouter", "openai-completions", "anthropic/claude-haiku-5.5", "openrouter")).toBe("none")
    expect(
      resolveModel("museum-gpt", {}, { prefill: "none" }, {}, {}, { kind: "openai-chat", api: "openai-completions" })
        .prefill
    ).toEqual({ value: "none", source: "user" })
  })
})
