// A preset's structural changes held behind the unsaved bar, switches live (presetHeld.ts).
import { describe, expect, it } from "vitest"
import {
  arrange,
  arrangeLorebooks,
  heldPromptPaths,
  heldText,
  NO_HELD,
  parseHeld,
  splitOrder,
  withHeld
} from "../src/presetHeld.ts"

const e = (identifier: string, enabled = true) => ({ identifier, enabled })
const ids = (list: ReadonlyArray<{ identifier: string }>) => list.map((x) => x.identifier)

describe("held order", () => {
  const live = [e("main"), e("a"), e("b"), e("c")]

  it("holds a move: the live order keeps its positions", () => {
    const moved = [e("main"), e("c"), e("a"), e("b")]
    const split = splitOrder(live, moved, NO_HELD)
    expect(ids(split.live)).toEqual(["main", "a", "b", "c"])
    expect(split.held).toEqual({ ...NO_HELD, order: ["main", "c", "a", "b"] })
    expect(ids(arrange(split.live, split.held))).toEqual(["main", "c", "a", "b"])
  })

  it("puts a switch flip live, keeping a held move", () => {
    const held = { ...NO_HELD, order: ["main", "c", "a", "b"] }
    const shown = arrange(live, held)
    const flipped = shown.map((x) => (x.identifier === "a" ? { ...x, enabled: false } : x))
    const split = splitOrder(live, flipped, held)
    expect(split.live).toEqual([e("main"), e("a", false), e("b"), e("c")])
    expect(split.held?.order).toEqual(["main", "c", "a", "b"])
  })

  it("holds a prompt added (owner, 2026-11-02): the live order doesn't have it, the shown one does", () => {
    const added = [e("main"), e("a"), e("new"), e("b"), e("c")]
    const split = splitOrder(live, added, { ...NO_HELD, added: [e("new")] })
    expect(ids(split.live)).toEqual(["main", "a", "b", "c"])
    expect(split.held?.added).toEqual([e("new")])
    expect(ids(arrange(split.live, split.held))).toEqual(["main", "a", "new", "b", "c"])
  })

  it("holds an added prompt's switch with it, and its definition's place in the live order", () => {
    const held = { ...NO_HELD, added: [e("new")], order: ["main", "new", "a", "b", "c"] }
    // `presetOrder` lists the live definition at the end, off: the held entry takes its place.
    const withDefinition = [...live, e("new", false)]
    expect(arrange(withDefinition, held)).toEqual([e("main"), e("new"), e("a"), e("b"), e("c")])
    const flipped = arrange(withDefinition, held).map((x) => (x.identifier === "new" ? { ...x, enabled: false } : x))
    const split = splitOrder(live, flipped, held)
    expect(ids(split.live)).toEqual(["main", "a", "b", "c"])
    expect(split.held?.added).toEqual([e("new", false)])
  })

  it("puts a prompt outside the order live when it's switched on: that's its switch", () => {
    const split = splitOrder(live, [...live, e("outside")], NO_HELD)
    expect(ids(split.live)).toEqual(["main", "a", "b", "c", "outside"])
    expect(split.held).toBeNull()
  })

  it("keeps a held deletion live until it's saved, and hides it", () => {
    const split = splitOrder(live, [e("main"), e("a"), e("c")], { ...NO_HELD, deleted: ["b"] })
    expect(ids(split.live)).toEqual(["main", "a", "b", "c"])
    expect(split.held).toEqual({ ...NO_HELD, deleted: ["b"] })
    expect(ids(arrange(split.live, split.held))).toEqual(["main", "a", "c"])
  })

  it("shows an entry the arrangement doesn't know after its live neighbour", () => {
    const held = { ...NO_HELD, order: ["c", "main", "a", "b"] }
    expect(ids(arrange([...live, e("d")], held))).toEqual(["c", "d", "main", "a", "b"])
  })
})

describe("held lorebooks", () => {
  const books = [
    { id: "fen", enabled: true },
    { id: "marsh", enabled: false }
  ]

  it("shows books taken off as gone and attached ones after the rest", () => {
    const held = { ...NO_HELD, detached: ["fen"], attached: [{ id: "moor", enabled: true }] }
    expect(arrangeLorebooks(books, held)).toEqual([
      { id: "marsh", enabled: false },
      { id: "moor", enabled: true }
    ])
  })

  it("shows a preset document with everything held in place", () => {
    const doc = {
      prompts: [
        { identifier: "main", name: "Main", content: "" },
        { identifier: "x", name: "X", content: "" }
      ],
      order: [e("main"), e("x")],
      lorebooks: books
    }
    const held = { ...NO_HELD, deleted: ["x"], attached: [{ id: "moor", enabled: true }] }
    const shown = withHeld(doc as never, held) as unknown as typeof doc
    expect(shown.prompts.map((p) => p.identifier)).toEqual(["main"])
    expect(ids(shown.order)).not.toContain("x")
    expect(shown.lorebooks.map((b) => b.id)).toEqual(["fen", "marsh", "moor"])
  })
})

describe("the held draft", () => {
  it("round-trips, keeps only what's in use, and is empty for nothing held", () => {
    const held = { ...NO_HELD, added: [e("new")], detached: ["fen"] }
    expect(heldText(held)).toBe(JSON.stringify({ added: [e("new")], detached: ["fen"] }))
    expect(parseHeld(heldText(held))).toEqual(held)
    expect(heldText(NO_HELD)).toBe("")
    expect(parseHeld("")).toBeNull()
    expect(parseHeld("{not json")).toBeNull()
    // The draft from before 2026-11-02 still reads.
    expect(parseHeld(JSON.stringify({ order: ["a"], deleted: [] }))).toEqual({ ...NO_HELD, order: ["a"] })
  })

  it("names an added prompt's definition, which a reply's checkpoint leaves for Save", () => {
    expect(heldPromptPaths({ ...NO_HELD, added: [e("new")] })).toEqual([["prompts", "identifier=new"]])
    expect(heldPromptPaths(null)).toEqual([])
  })
})
