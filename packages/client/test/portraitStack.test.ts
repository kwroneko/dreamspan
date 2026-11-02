// The portrait column's stack (owner, 2026-11-02): a click opens a portrait on top, or closes
// the one open; with one kept at a time it replaces the image; boundaries split two heights.
import { describe, expect, it } from "vitest"
import { close, even, isOpen, keepOnly, replace, show, split, type Stack, toggle } from "../src/ui/portraitStack.ts"

const p = (id: string) => ({ id, name: id.toUpperCase(), mediaId: `m-${id}` })
const ids = (stack: Stack) => stack.map((entry) => entry.portrait.id)
const shares = (stack: Stack) => {
  const sum = stack.reduce((total, entry) => total + entry.weight, 0)
  return stack.map((entry) => Math.round((entry.weight / sum) * 1000) / 1000)
}
const three = toggle(toggle(toggle([], p("a"), false), p("b"), false), p("c"), false)

describe("stacking", () => {
  it("opens each new one on top, with an equal share", () => {
    expect(ids(three)).toEqual(["c", "b", "a"])
    expect(shares(three)).toEqual([0.333, 0.333, 0.333])
  })
  it("a new one takes its equal share from the others in proportion", () => {
    const uneven = split(toggle(toggle([], p("a"), false), p("b"), false), 0, 300, 400, 100)
    expect(shares(uneven)).toEqual([0.75, 0.25])
    const added = toggle(uneven, p("c"), false)
    expect(ids(added)).toEqual(["c", "b", "a"])
    expect(shares(added)).toEqual([0.333, 0.5, 0.167])
  })
  it("a click on one that's open closes only it", () => {
    expect(ids(toggle(three, p("b"), false))).toEqual(["c", "a"])
    expect(ids(close(three, "c"))).toEqual(["b", "a"])
    expect(toggle(toggle([], p("a"), false), p("a"), false)).toEqual([])
  })
  it("show opens without ever closing", () => {
    expect(show(three, p("b"), false)).toBe(three)
    expect(ids(show(three, p("d"), false))).toEqual(["d", "c", "b", "a"])
  })
  it("replace swaps a card in place, keeping its share", () => {
    const swapped = replace(three, "b", p("x"))
    expect(ids(swapped)).toEqual(["c", "x", "a"])
    expect(swapped[1]!.weight).toBe(three[1]!.weight)
    expect(replace(three, "z", p("x"))).toBe(three)
    expect(ids(replace(three, "b", p("a")))).toEqual(["c", "a"])
  })
})

describe("one at a time", () => {
  it("a click replaces the image, or closes the one shown", () => {
    const one = toggle([], p("a"), true)
    expect(ids(toggle(one, p("b"), true))).toEqual(["b"])
    expect(toggle(one, p("a"), true)).toEqual([])
    expect(ids(show(one, p("b"), true))).toEqual(["b"])
  })
  it("keepOnly closes the others and gives the one kept the whole column", () => {
    const kept = keepOnly(split(three, 0, 100, 400, 50), "b")
    expect(ids(kept)).toEqual(["b"])
    expect(kept[0]!.weight).toBe(1)
    expect(isOpen(kept, "c")).toBe(false)
  })
  it("several open when it's turned on elsewhere collapse to the one clicked", () => {
    expect(ids(toggle(three, p("d"), true))).toEqual(["d"])
    expect(ids(show(three, p("b"), true))).toEqual(["b"])
  })
})

describe("boundaries", () => {
  it("split changes only the two either side, keeping their sum", () => {
    const moved = split(three, 1, 500, 600, 100)
    expect(moved[0]!.weight).toBe(three[0]!.weight)
    expect(moved[1]!.weight + moved[2]!.weight).toBeCloseTo(three[1]!.weight + three[2]!.weight)
    expect(moved[1]!.weight / moved[2]!.weight).toBeCloseTo(5)
  })
  it("split keeps each at its minimum", () => {
    expect(shares(split(three, 0, 10, 600, 180)).slice(0, 2)).toEqual([0.2, 0.467])
    expect(shares(split(three, 0, 590, 600, 180)).slice(0, 2)).toEqual([0.467, 0.2])
    expect(split(three, 2, 100, 600, 100)).toBe(three)
  })
  it("even shares the two equally", () => {
    const evened = even(split(three, 0, 500, 600, 100), 0)
    expect(shares(evened)).toEqual([0.333, 0.333, 0.333])
  })
})
