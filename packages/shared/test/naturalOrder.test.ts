// ST's natural order with seeded rolls: synthetic members only.
import { describe, expect, it } from "vitest"
import { hashSeed, mulberry32, naturalOrder, type NaturalMember, talkativenessOf } from "../src/naturalOrder.ts"

const member = (id: string, talkativeness: number, name = id): NaturalMember<string> => ({ id, name, talkativeness })
const seeds = Array.from({ length: 200 }, (_, i) => i * 7919 + 1)

describe("talkativeness", () => {
  it("reads numbers and numeric strings, clamps, and defaults to ST's 0.5", () => {
    expect([0, 1, 0.25, "0.8", 2, -1, undefined, null, "", "abc", Number.NaN, Infinity].map(talkativenessOf)).toEqual([
      0, 1, 0.25, 0.8, 1, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5
    ])
  })
})

describe("the PRNG", () => {
  it("is deterministic for a seed and different across seeds", () => {
    const a = mulberry32(42),
      b = mulberry32(42),
      c = mulberry32(43)
    const xs = Array.from({ length: 5 }, a)
    expect(Array.from({ length: 5 }, b)).toEqual(xs)
    expect(Array.from({ length: 5 }, c)).not.toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(hashSeed(["tip", "a"])).toBe(hashSeed(["tip", "a"]))
    expect(hashSeed(["tip", "a"])).not.toBe(hashSeed(["tipa"]))
  })
})

describe("natural order", () => {
  const cast = [member("mira", 0.5, "Mira Vale"), member("tobin", 0.5, "Tobin"), member("wren", 0.5, "Wren")]

  it("puts members named in the input first, by whole words of their name, in the order named", () => {
    for (const seed of seeds) {
      const order = naturalOrder(cast, "Wren, ask vale about it.", null, mulberry32(seed))
      expect(order.slice(0, 2)).toEqual(["wren", "mira"])
    }
    // Part of a word isn't a name; case and punctuation don't matter.
    const two = [member("mira", 1, "Mira"), member("tobin", 0, "Tobin")]
    expect(naturalOrder(two, "Tobinson", null, mulberry32(1))).toEqual(["mira"])
    expect(naturalOrder(two, "TOBIN!", null, mulberry32(1))).toEqual(["tobin", "mira"])
  })

  it("always activates talkativeness 1 and never 0 by the roll", () => {
    const members = [member("a", 1), member("b", 0), member("c", 1)]
    for (const seed of seeds) {
      const order = naturalOrder(members, "", null, mulberry32(seed))
      expect([...order].sort()).toEqual(["a", "c"])
    }
  })

  it("falls back to one pick among the chatty when every roll misses", () => {
    // A 1e-9 chance of passing a roll: the fallback decides, and never picks the silent one.
    const members = [member("a", 1e-9), member("b", 0), member("c", 1e-9)]
    const picks = new Set<string>()
    for (const seed of seeds) {
      const order = naturalOrder(members, "", null, mulberry32(seed))
      expect(order).toHaveLength(1)
      picks.add(order[0]!)
    }
    expect([...picks].sort()).toEqual(["a", "c"])
    // No one chatty: anyone.
    const silent = naturalOrder([member("a", 0), member("b", 0)], "", null, mulberry32(3))
    expect(silent).toHaveLength(1)
  })

  it("skips the banned last speaker, unless they're the only one", () => {
    const members = [member("a", 1), member("b", 1)]
    for (const seed of seeds) expect(naturalOrder(members, "a", "a", mulberry32(seed))).toEqual(["b"])
    // Banned and the others silent: one of the others, not the banned one.
    for (const seed of seeds)
      expect(naturalOrder([member("a", 1), member("b", 0), member("c", 0)], "", "a", mulberry32(seed))).not.toContain(
        "a"
      )
    expect(naturalOrder([member("a", 1)], "", "a", mulberry32(1))).toEqual(["a"])
  })

  it("is the same for the same seed, and varies with it", () => {
    const members = [member("a", 0.5), member("b", 0.5), member("c", 0.5), member("d", 0.5)]
    const firsts = new Set<string>()
    for (const seed of seeds) {
      const once = naturalOrder(members, "", null, mulberry32(seed))
      expect(naturalOrder(members, "", null, mulberry32(seed))).toEqual(once)
      expect(new Set(once).size).toBe(once.length)
      firsts.add(once[0]!)
    }
    expect(firsts.size).toBe(4)
  })
})
