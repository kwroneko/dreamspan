import { describe, expect, it } from "vitest"
import { defaultLibraryMergePolicy as policy } from "../src/forkMerge.ts"

const entry = (uid: number, content = String(uid)) => ({ uid, content })
describe("explicit merge choices", () => {
  it("shows only changed elements and order; includes adds, deletes and clean word merges", () => {
    const base = { entries: [entry(1), entry(2)], text: "One sentence. Another sentence.", unchanged: "quiet" }
    const ours = { ...base, text: "First sentence. Another sentence." }
    const theirs = { ...base, entries: [entry(2, "changed"), entry(3)], text: "One sentence. Last sentence." }
    const preview = policy.prepare(base, ours, theirs)
    expect(preview.units.map((u) => u.path)).toEqual([
      ["entries", "uid=1"],
      ["entries", "uid=2"],
      ["entries", "uid=3"],
      ["entries", "$order"],
      ["text"]
    ])
    expect(
      policy.resolve(base, ours, theirs, {
        excluded: [
          ["entries", "uid=1"],
          ["entries", "uid=3"]
        ],
        resolutions: []
      })
    ).toEqual({
      entries: [entry(2, "changed"), entry(1)],
      text: "First sentence. Last sentence.",
      unchanged: "quiet"
    })
  })
  it("conflicting moves resolve order independently of content", () => {
    const base = { entries: [entry(1), entry(2), entry(3)] }
    const ours = { entries: [entry(2, "ours"), entry(1), entry(3)] }
    const theirs = { entries: [entry(1), entry(3, "theirs"), entry(2)] }
    const p = policy.prepare(base, ours, theirs)
    expect(p.conflicts.map((c) => c.path)).toEqual([["entries", "$order"]])
    expect(
      policy.resolve(base, ours, theirs, {
        excluded: [],
        resolutions: [{ path: ["entries", "$order"], value: [1, 3, 2] }]
      })
    ).toEqual({ entries: [entry(1), entry(3, "theirs"), entry(2, "ours")] })
    expect(policy.resolve(base, ours, theirs, { excluded: [["entries", "$order"]], resolutions: [] })).toEqual({
      entries: [entry(2, "ours"), entry(1), entry(3, "theirs")]
    })
  })
  it("modify/delete conflicts can be excluded, resolved or deleted; invalid choices refuse", () => {
    const base = { entries: [entry(1)] }
    const ours = { entries: [entry(1, "ours")] }
    const theirs = { entries: [] }
    expect(() => policy.resolve(base, ours, theirs, { excluded: [], resolutions: [] })).toThrow("Resolve")
    expect(policy.resolve(base, ours, theirs, { excluded: [["entries", "uid=1"]], resolutions: [] })).toEqual(ours)
    expect(policy.resolve(base, ours, theirs, { excluded: [], resolutions: [{ path: ["entries", "uid=1"] }] })).toEqual(
      theirs
    )
    expect(() => policy.resolve(base, ours, theirs, { excluded: [["unknown"]], resolutions: [] })).toThrow("absent")
    expect(() =>
      policy.resolve(base, ours, theirs, { excluded: [], resolutions: [{ path: ["unknown"], value: 1 }] })
    ).toThrow("absent")
  })
  it("prototype keys remain ordinary own data in selections", () => {
    const base = JSON.parse('{"__proto__":{"x":1}}')
    const ours = JSON.parse('{"__proto__":{"x":2}}')
    const theirs = JSON.parse('{"__proto__":{"x":3}}')
    expect(
      JSON.stringify(
        policy.resolve(base, ours, theirs, { excluded: [], resolutions: [{ path: ["__proto__", "x"], value: 4 }] })
      )
    ).toBe('{"__proto__":{"x":4}}')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})
