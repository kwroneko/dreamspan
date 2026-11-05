import { describe, expect, it } from "vitest"
import type { RolloutStep, TranscriptEntry } from "@rp/shared/agent.ts"
import {
  durationText,
  excerpt,
  isOpen,
  stepsText,
  stepsView,
  toolCount,
  turnsOf
} from "../src/features/chat/agent/steps.ts"

const tool = (id: string, status: "running" | "done" | "error" = "done"): RolloutStep => ({
  kind: "tool",
  id,
  tool: "search_chat",
  label: "Searched the chat",
  title: "“lighthouse”",
  args: { query: "lighthouse" },
  status,
  effect: "read"
})

describe("an agent reply's steps", () => {
  it("counts tool calls, not the thinking and text between them", () => {
    expect(
      toolCount([{ kind: "thinking", text: "Hm." }, tool("a"), { kind: "text", text: "Let me look." }, tool("b")])
    ).toBe(2)
  })

  it("says the count and the run's time", () => {
    expect(stepsText(3, 14_200)).toBe("3 steps · 14 s")
    expect(stepsText(1, null)).toBe("1 step")
    expect(durationText(125_000)).toBe("2 min 5 s")
    expect(durationText(120_000)).toBe("2 min")
  })

  it("shows live steps while generating, and afterwards only for a run with tool calls", () => {
    const live = [tool("a", "running")]
    expect(stepsView(live, undefined, true)).toEqual({ running: true, count: 1, ms: null, live })
    // Before the first step there's nothing to show.
    expect(stepsView(null, undefined, true)).toBeNull()
    expect(stepsView([], { count: 0, ms: null }, true)).toBeNull()
    // Done: the version's summary, the steps read when opened.
    expect(stepsView(null, { count: 2, ms: 9000 }, false)).toEqual({ running: false, count: 2, ms: 9000, live: null })
    // A plain reply, or an agent reply that called no tool, shows nothing.
    expect(stepsView(null, undefined, false)).toBeNull()
    expect(stepsView(null, { count: 0, ms: 300 }, false)).toBeNull()
  })

  it("opens while streaming as the user prefers, folds when done, and keeps a choice only for its phase", () => {
    expect(isOpen(null, true, "expanded")).toBe(true)
    expect(isOpen(null, true, "collapsed")).toBe(false)
    expect(isOpen(null, false, "expanded")).toBe(false)
    // Folded during the run: folded while it runs, and folded after as every finished reply is.
    expect(isOpen({ open: false, streaming: true }, true, "expanded")).toBe(false)
    // Opened during the run: when the message arrives it folds anyway (DESIGN §7.4).
    expect(isOpen({ open: true, streaming: true }, false, "expanded")).toBe(false)
    expect(isOpen({ open: true, streaming: false }, false, "collapsed")).toBe(true)
  })

  it("cuts a step's text to its first line", () => {
    expect(excerpt("  First line\nsecond")).toBe("First line")
    expect(excerpt("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`)
  })

  it("groups a transcript into requests: what each added, then the answer", () => {
    const call: TranscriptEntry = {
      role: "assistant",
      parts: [{ type: "toolCall", id: "c1", name: "search_chat", args: { query: "bridge" } }],
      stopReason: "toolUse",
      toolsOffered: true
    }
    const result: TranscriptEntry = {
      role: "toolResult",
      toolCallId: "c1",
      tool: "search_chat",
      text: "#3",
      isError: false
    }
    const nudge: TranscriptEntry = { role: "app", text: "Write the reply now." }
    const answer: TranscriptEntry = {
      role: "assistant",
      parts: [{ type: "text", text: "Done." }],
      stopReason: "stop",
      toolsOffered: true
    }
    expect(turnsOf([call, result, nudge, answer])).toEqual([
      { added: [], answer: call },
      { added: [result, nudge], answer }
    ])
    // Stopped after a result: the last request was never sent.
    expect(turnsOf([call, result])).toEqual([
      { added: [], answer: call },
      { added: [result], answer: null }
    ])
  })
})
