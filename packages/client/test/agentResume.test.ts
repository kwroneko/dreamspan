import { describe, expect, it } from "vitest"
import type { TranscriptEntry, TurnPart } from "@dreamspan/shared/agent.ts"
import type { Version } from "@dreamspan/shared/chat.ts"
import { editableText, resumeOffer, schemaProblem, stepEdit } from "../src/features/chat/agent/resume.ts"

const version = (fields: Partial<Version>) =>
  ({ status: "stopped", writer: "model", content: "", agent: true, ...fields }) as Version

describe("Resume on an agent reply", () => {
  it("is offered on an agent reply that stopped, failed or was interrupted, and nowhere else", () => {
    for (const status of ["stopped", "failed", "interrupted"] as const)
      expect(resumeOffer(version({ status, content: "Mira lif" }))).toEqual({ disabled: null })
    for (const status of ["complete", "generating"] as const) expect(resumeOffer(version({ status }))).toBeNull()
    // A plain reply, and the user's own text, have no run to carry on.
    expect(resumeOffer({ ...version({ content: "Hi" }), agent: undefined } as unknown as Version)).toBeNull()
    expect(resumeOffer(version({ writer: "human", content: "Hi" }))).toBeNull()
  })

  it("is offered when the reply stopped before writing anything: it starts over from its saved request", () => {
    expect(resumeOffer(version({}))).toEqual({ disabled: null })
    expect(resumeOffer(version({ status: "failed" }))).toEqual({ disabled: null })
    expect(resumeOffer(version({ steps: { count: 1, ms: 30 } }))).toEqual({ disabled: null })
    expect(resumeOffer(version({ reasoning: "Hm." }))).toEqual({ disabled: null })
  })
})

const call: TurnPart = { type: "toolCall", id: "call_1", name: "search_chat", args: { query: "bridge" }, step: 1 }
const result: Extract<TranscriptEntry, { role: "toolResult" }> = {
  role: "toolResult",
  toolCallId: "call_1",
  tool: "search_chat",
  text: "Message 2: the bridge.",
  isError: false,
  step: 1
}
const parameters = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    speaker: { anyOf: [{ type: "string" }, { type: "null" }] },
    order: { type: "string", enum: ["newest", "oldest"] }
  },
  required: ["query"]
}

describe("editing a step before resuming", () => {
  it("opens a call's arguments as JSON and other steps as their text", () => {
    expect(editableText({ kind: "part", part: call })).toBe('{\n  "query": "bridge"\n}')
    expect(editableText({ kind: "result", entry: result })).toBe("Message 2: the bridge.")
    expect(editableText({ kind: "part", part: { type: "thinking", text: "Hm.", step: 0 } })).toBe("Hm.")
  })

  it("sends no edit when nothing changed: that's Resume from here", () => {
    expect(stepEdit({ kind: "result", entry: result }, result.text, undefined)).toEqual({ edit: undefined })
    expect(stepEdit({ kind: "part", part: call }, editableText({ kind: "part", part: call }), parameters)).toEqual({
      edit: undefined
    })
  })

  it("sends new text, a new result, or new arguments that fit the tool's schema", () => {
    expect(stepEdit({ kind: "part", part: { type: "text", text: "A", step: 0 } }, "B", undefined)).toEqual({
      edit: { kind: "text", text: "B" }
    })
    expect(stepEdit({ kind: "result", entry: result }, "Nothing found.", undefined)).toEqual({
      edit: { kind: "result", text: "Nothing found." }
    })
    expect(stepEdit({ kind: "part", part: call }, '{"query":"lantern","limit":3}', parameters)).toEqual({
      edit: { kind: "arguments", arguments: { query: "lantern", limit: 3 } }
    })
  })

  it("refuses arguments that aren't a JSON object or don't fit the schema, saying why", () => {
    const problem = (text: string) => {
      const checked = stepEdit({ kind: "part", part: call }, text, parameters)
      return "problem" in checked ? checked.problem : null
    }
    expect(problem("{query:")).toBe("The arguments aren't valid JSON.")
    expect(problem('["bridge"]')).toBe("The arguments must be a JSON object, in braces.")
    expect(problem('{"limit":3}')).toMatch(/^“query” is missing\./)
    expect(problem('{"query":3}')).toMatch(/^“query” must be text in quotes\./)
    expect(problem('{"query":"a","limit":1.5}')).toMatch(/^“limit” must be a whole number\./)
    expect(problem('{"query":"a","order":"sideways"}')).toMatch(/^“order” must be one of "newest", "oldest"\./)
    expect(problem('{"query":"a","speaker":null}')).toBeNull()
    expect(problem('{"query":"a","speaker":4}')).toMatch(/^“speaker” doesn't fit any of its allowed forms\./)
  })

  it("checks list items", () => {
    expect(schemaProblem([1, "a"], { type: "array", items: { type: "number" } })).toBe("Item 2 must be a number.")
  })
})
