import { expect, it } from "vitest"
import { takesVerbosity } from "../src/samplerRules.ts"

for (const api of ["openai-completions", "openai-responses"])
  it(`${api} shows verbosity for opaque aliases and fine-tunes unless explicitly disabled`, () => {
    for (const key of ["museum-gpt", "ft:gpt-5.4-mini:synthetic::deployment"])
      expect(takesVerbosity({ api, key }), key).toBe(true)
    expect(takesVerbosity({ api, key: "museum-gpt", supported: false })).toBe(false)
    expect(takesVerbosity({ api, key: "museum-gpt", supported: true })).toBe(true)
  })

it("does not add the OpenAI verbosity field to other wires", () => {
  expect(takesVerbosity({ api: "anthropic-messages", key: "museum-gpt", supported: true })).toBe(false)
})
