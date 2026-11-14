import { describe, expect, it } from "vitest"
import type { ConnectionDecisions, DecisionPointInfo } from "@rp/shared/decisions.ts"
import { chatDecisionRows, withDecision } from "../src/features/decisions/ChatDecisions.tsx"

const points: ReadonlyArray<DecisionPointInfo> = [
  { id: "lore", label: "Lorebook entries", description: "Asks about entries.", defaultThreshold: 0.7 },
  { id: "presence", label: "Who is in the scene", description: "Asks who's there.", defaultThreshold: 0.85 },
  { id: "next", label: "Who replies next", description: "Picks who replies.", defaultThreshold: 0.5 }
]

const connection = (model: string | null, on: ReadonlyArray<string>): ConnectionDecisions =>
  ({
    connectionId: "c1",
    model,
    points: Object.fromEntries(on.map((id) => [id, { on: true, threshold: 0.7 }]))
  }) as ConnectionDecisions

describe("this chat's Decisions setting", () => {
  it("shows nothing while no connection has a decision on and the chat turned none off", () => {
    expect(chatDecisionRows(points, [], [])).toEqual([])
    // On for a connection without a model chosen: nothing is asked, so nothing to switch.
    expect(chatDecisionRows(points, [connection(null, ["next"])], [])).toEqual([])
  })

  it("lists what a connection has on, each on here unless the chat turned it off", () => {
    const rows = chatDecisionRows(points, [connection("m1", ["lore", "next"])], ["next"])
    expect(rows.map((row) => [row.point.id, row.available, row.on])).toEqual([
      ["lore", true, true],
      ["next", true, false]
    ])
  })

  it("keeps a decision the chat turned off listed after its connection turned it off, so it can be cleared", () => {
    const rows = chatDecisionRows(points, [connection("m1", ["lore"])], ["presence"])
    expect(rows.map((row) => [row.point.id, row.available, row.on])).toEqual([
      ["lore", true, true],
      ["presence", false, false]
    ])
  })

  it("writes the whole list, in the points' order, without ids nothing registers", () => {
    expect(withDecision(points, [], "next", false)).toEqual(["next"])
    expect(withDecision(points, ["next", "gone"], "lore", false)).toEqual(["lore", "next"])
    expect(withDecision(points, ["lore", "next"], "next", true)).toEqual(["lore"])
    expect(withDecision(points, ["next"], "next", true)).toEqual([])
  })
})
