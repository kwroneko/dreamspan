// A preset's moves and deletions held behind the unsaved bar, the rest live (heldOrder.ts).
import { describe, expect, it } from "vitest"
import { arrange, splitOrder } from "../src/features/editor/heldOrder.ts"

const e = (identifier: string, enabled = true) => ({ identifier, enabled })
const ids = (list: ReadonlyArray<{ identifier: string }>) => list.map((x) => x.identifier)

describe("held order", () => {
  const live = [e("main"), e("a"), e("b"), e("c")]

  it("holds a move: the live order keeps its positions", () => {
    const moved = [e("main"), e("c"), e("a"), e("b")]
    const split = splitOrder(live, moved, [])
    expect(ids(split.live)).toEqual(["main", "a", "b", "c"])
    expect(split.held).toEqual({ order: ["main", "c", "a", "b"], deleted: [] })
    expect(ids(arrange(split.live, split.held))).toEqual(["main", "c", "a", "b"])
  })

  it("puts a switch flip live, keeping a held move", () => {
    const held = { order: ["main", "c", "a", "b"], deleted: [] }
    const shown = arrange(live, held)
    const flipped = shown.map((x) => (x.identifier === "a" ? { ...x, enabled: false } : x))
    const split = splitOrder(live, flipped, [])
    expect(split.live).toEqual([e("main"), e("a", false), e("b"), e("c")])
    expect(split.held?.order).toEqual(["main", "c", "a", "b"])
  })

  it("puts an addition live after its neighbour above, with nothing held when nothing moved", () => {
    const added = [e("main"), e("a"), e("new"), e("b"), e("c")]
    const split = splitOrder(live, added, [])
    expect(ids(split.live)).toEqual(["main", "a", "new", "b", "c"])
    expect(split.held).toBeNull()
  })

  it("keeps a held deletion live until it's saved, and hides it", () => {
    const split = splitOrder(live, [e("main"), e("a"), e("c")], ["b"])
    expect(ids(split.live)).toEqual(["main", "a", "b", "c"])
    expect(split.held).toEqual({ order: [], deleted: ["b"] })
    expect(ids(arrange(split.live, split.held))).toEqual(["main", "a", "c"])
  })

  it("shows an entry the arrangement doesn't know after its live neighbour", () => {
    const held = { order: ["c", "main", "a", "b"], deleted: [] }
    expect(ids(arrange([...live, e("d")], held))).toEqual(["c", "d", "main", "a", "b"])
  })
})
