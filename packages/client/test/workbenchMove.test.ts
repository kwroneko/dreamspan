// Moving a tab to a new frame or the frame beside (features/workbench/model.ts, owner
// 2026-11-23): a frame's only tab leaves first, as closing it would, and the node that took its
// place is split; a menu item that wouldn't change the layout is disabled (`canApply`).
import { describe, expect, it } from "vitest"
import {
  applyAction,
  canApply,
  type Direction,
  frames,
  type Layout,
  type LayoutAction,
  moveToNewFrame,
  neighbours,
  type Node
} from "../src/features/workbench/model.ts"

/** A frame is its tabs' names; a split is `[direction, ...children]`. */
type Shape = ReadonlyArray<string | Shape>

let ids = 0
const node = (shape: Shape): Node => {
  if (shape[0] === "row" || shape[0] === "column") {
    const direction: Direction = shape[0]
    const children = shape.slice(1) as ReadonlyArray<Shape>
    return {
      type: "split",
      id: `s${ids++}`,
      direction,
      children: children.map(node),
      sizes: children.map(() => 1 / children.length)
    }
  }
  const tabs = (shape as ReadonlyArray<string>).map((name) => ({ id: name, href: `/${name}`, preview: false }))
  return { type: "frame", id: `f${ids++}`, tabs, active: tabs[0]?.id ?? null }
}

const build = (shape: Shape): Layout => {
  const root = node(shape)
  return { root, focused: frames(root)[0]!.id, recent: [] }
}

const draw = (n: Node): Shape => (n.type === "frame" ? n.tabs.map((t) => t.id) : [n.direction, ...n.children.map(draw)])

const toNew = (tabId: string, side: "left" | "right" | "up" | "down"): LayoutAction => ({
  type: "moveToNewFrame",
  tabId,
  direction: side === "left" || side === "right" ? "row" : "column",
  before: side === "left" || side === "up"
})

const after = (layout: Layout, action: LayoutAction) => draw(applyAction(layout, action).root)

const frameOf = (layout: Layout, tabId: string) =>
  frames(layout.root).find((f) => f.tabs.some((t) => t.id === tabId))!.id

describe("Move to a new frame", () => {
  it("takes a frame's only tab out first, then splits what took its place", () => {
    const layout = build(["row", ["A"], ["B"]])
    expect(after(layout, toNew("B", "down"))).toEqual(["column", ["A"], ["B"]])
    expect(after(layout, toNew("B", "up"))).toEqual(["column", ["B"], ["A"]])
    expect(after(layout, toNew("B", "left"))).toEqual(["row", ["B"], ["A"]])
    expect(canApply(layout, toNew("B", "right"))).toBe("same")
    expect(after(layout, toNew("A", "down"))).toEqual(["column", ["B"], ["A"]])
    expect(after(layout, toNew("A", "right"))).toEqual(["row", ["B"], ["A"]])
    expect(canApply(layout, toNew("A", "left"))).toBe("same")
    // The moved tab is shown and focused in its new frame.
    const moved = applyAction(layout, toNew("B", "down"))
    expect(moved.focused).toBe(frameOf(moved, "B"))
  })

  it("does the same inside nested splits", () => {
    // A | (B over C)
    const layout = build(["row", ["A"], ["column", ["B"], ["C"]]])
    expect(after(layout, toNew("C", "right"))).toEqual(["row", ["A"], ["B"], ["C"]])
    expect(after(layout, toNew("C", "left"))).toEqual(["row", ["A"], ["C"], ["B"]])
    expect(after(layout, toNew("C", "up"))).toEqual(["row", ["A"], ["column", ["C"], ["B"]]])
    expect(canApply(layout, toNew("C", "down"))).toBe("same")
    // A whole split takes the place: B over C, beside A's only tab moved below.
    expect(after(layout, toNew("A", "down"))).toEqual(["column", ["B"], ["C"], ["A"]])
    expect(after(layout, toNew("A", "right"))).toEqual(["row", ["column", ["B"], ["C"]], ["A"]])
    // Three in a row: the middle one's only tab goes below the one before it.
    const three = build(["row", ["A"], ["B"], ["C"]])
    expect(after(three, toNew("B", "down"))).toEqual(["row", ["column", ["A"], ["B"]], ["C"]])
  })

  it("splits the tab's own frame when it has other tabs", () => {
    const layout = build(["A", "B"])
    expect(after(layout, toNew("B", "down"))).toEqual(["column", ["A"], ["B"]])
    expect(after(layout, toNew("B", "left"))).toEqual(["row", ["B"], ["A"]])
    const split = build(["row", ["A", "B"], ["C"]])
    expect(after(split, toNew("A", "down"))).toEqual(["row", ["column", ["B"], ["A"]], ["C"]])
    expect(after(split, toNew("B", "right"))).toEqual(["row", ["A"], ["B"], ["C"]])
  })

  it("can't move the only tab of the only frame", () => {
    const layout = build(["A"])
    for (const side of ["left", "right", "up", "down"] as const) expect(canApply(layout, toNew("A", side))).toBe("none")
    expect(moveToNewFrame(layout, "A", "column")).toBe(layout)
    // Split still shows it a second time.
    expect(canApply(layout, { type: "split", frameId: frameOf(layout, "A"), direction: "column" })).toBe("yes")
  })
})

describe("Move to the frame beside", () => {
  it("moves into a neighbour, and can't where there's none", () => {
    const layout = build(["row", ["A"], ["B"]])
    const near = neighbours(layout, frameOf(layout, "B"))
    expect(after(layout, { type: "move", tabId: "B", frameId: near.left })).toEqual(["A", "B"])
    expect(canApply(layout, { type: "move", tabId: "B", frameId: near.right })).toBe("none")
    expect(canApply(layout, { type: "move", tabId: "B", frameId: near.down })).toBe("none")
    const nested = build(["row", ["A"], ["column", ["B"], ["C", "D"]]])
    const fromD = neighbours(nested, frameOf(nested, "D"))
    expect(after(nested, { type: "move", tabId: "D", frameId: fromD.up })).toEqual([
      "row",
      ["A"],
      ["column", ["B", "D"], ["C"]]
    ])
    expect(after(nested, { type: "move", tabId: "D", frameId: fromD.left })).toEqual([
      "row",
      ["A", "D"],
      ["column", ["B"], ["C"]]
    ])
  })
})

describe("canApply", () => {
  it("checks every item of a busy layout's menus well under a millisecond", { tags: ["slow"] }, () => {
    // Twelve frames of ten tabs, in nested splits.
    let n = 0
    const frame = () => Array.from({ length: 10 }, () => `t${n++}`)
    const built = build([
      "row",
      ["column", frame(), ["row", frame(), frame()], frame()],
      ["column", ["row", frame(), ["column", frame(), frame()]], frame()],
      ["column", frame(), frame(), ["row", frame(), frame()]]
    ])
    // Every tab focused once, as after a long session.
    const layout = { ...built, recent: frames(built.root).flatMap((f) => f.tabs.map((t) => t.id)) }
    expect(frames(layout.root)).toHaveLength(12)
    // One menu: the 2 splits and 8 moves for one tab, the way TabActions asks.
    const check = (tabId: string) => {
      const frameId = frameOf(layout, tabId)
      const near = neighbours(layout, frameId)
      canApply(layout, { type: "split", frameId, direction: "row" })
      canApply(layout, { type: "split", frameId, direction: "column" })
      for (const to of [near.left, near.right, near.up, near.down])
        canApply(layout, { type: "move", tabId, frameId: to })
      for (const side of ["left", "right", "up", "down"] as const) canApply(layout, toNew(tabId, side))
    }
    for (let i = 0; i < 2000; i++) check(`t${i % 120}`)
    const runs = 2000
    const start = performance.now()
    for (let i = 0; i < runs; i++) check(`t${(i * 7) % 120}`)
    const perMenu = (performance.now() - start) / runs
    console.log(`canApply: ${(perMenu * 1000).toFixed(1)} µs per menu (10 items, 12 frames × 10 tabs)`)
    expect(perMenu).toBeLessThan(1)
  })
})
