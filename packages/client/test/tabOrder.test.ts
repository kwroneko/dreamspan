// The chat panel's tool order (DESIGN §10.1 "Tab order"): one stored list, tools it doesn't
// name after it, tools this chat lacks kept in place, and a fit that reserves the open tool's
// room before counting, so the row can't flip between two layouts at a boundary width.
import { describe, expect, it } from "vitest"
import { fitTools, inOrder, moved, placedBefore, storedOrder, TOOL_GAP } from "../src/ui/tabOrder.ts"

const tabs = (...values: Array<string>) => values.map((value) => ({ value }))
const names = (list: ReadonlyArray<{ value: string }>) => list.map((tab) => tab.value)

describe("inOrder", () => {
  it("keeps the usual order when nothing is stored", () => {
    expect(names(inOrder(tabs("a", "b", "c"), []))).toEqual(["a", "b", "c"])
  })
  it("puts stored tools first in their order, new ones after in their own", () => {
    expect(names(inOrder(tabs("a", "b", "c", "plugin"), ["c", "a", "gone", "b"]))).toEqual(["c", "a", "b", "plugin"])
  })
})

describe("storedOrder", () => {
  it("keeps a tool this chat doesn't offer after the one it followed", () => {
    // Summaries is absent in a workshop; arranging there doesn't lose its place.
    expect(storedOrder(["chat", "summaries", "notes", "model"], ["model", "chat", "notes"])).toEqual([
      "model",
      "chat",
      "summaries",
      "notes"
    ])
    expect(storedOrder(["summaries", "chat"], ["chat"])).toEqual(["summaries", "chat"])
  })
})

describe("moves", () => {
  it("moves to an index and before an item", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
    expect(placedBefore(["a", "b", "c", "d"], "a", 3)).toEqual(["b", "c", "a", "d"])
    expect(placedBefore(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"])
    expect(placedBefore(["a", "b", "c", "d"], "b", 4)).toEqual(["a", "c", "d", "b"])
  })
})

describe("fitTools", () => {
  const widths = [50, 50, 50, 50, 50]
  const step = 50 + TOOL_GAP
  const more = 40
  const divider = 5
  it("shows everything that fits, without More", () => {
    expect(fitTools(widths, more, divider, 5 * step, 4)).toEqual({ count: 5, guest: false })
  })
  it("counts a prefix beside More, and the open one inside it isn't a guest", () => {
    expect(fitTools(widths, more, divider, more + TOOL_GAP + 3 * step, 1)).toEqual({ count: 3, guest: false })
  })
  it("shows an open tool past the prefix as a guest, its room kept first", () => {
    const room = more + TOOL_GAP + 3 * step
    expect(fitTools(widths, more, divider, room, 4)).toEqual({ count: 1, guest: true })
  })
  it("never flips at any width: the result for a width doesn't depend on the last one", () => {
    for (let room = 100; room <= 5 * step + 10; room++) {
      const first = fitTools(widths, more, divider, room, 4)
      expect(fitTools(widths, more, divider, room, 4)).toEqual(first)
      // What's shown fits in the room.
      if (first.count < widths.length) {
        const used =
          more + TOOL_GAP + first.count * step + (first.guest ? widths[4]! + TOOL_GAP + divider + TOOL_GAP : 0)
        if (first.count > 0) expect(used).toBeLessThanOrEqual(room)
      }
      // Widening never shows fewer tools.
      const wider = fitTools(widths, more, divider, room + 1, 4)
      expect(wider.count + Number(wider.guest)).toBeGreaterThanOrEqual(first.count + Number(first.guest))
    }
  })
})
