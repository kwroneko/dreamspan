import { describe, expect, it } from "vitest"
import { loreEffectsAt, loreEntryKey, loreIdentity, type LoreTimeline } from "../src/assembler/loreTiming.ts"
import { matchLorebooks } from "../src/assembler/lorebook.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const entry = loreEntry({ keys: ["cat"], sticky: 3, cooldown: 2, content: "dragon" })
const key = loreIdentity("synthetic", entry)
const admission = { id: "version-a", at: 1, entries: [{ key, sticky: 3, cooldown: 2 }] }
const effects = (count: number, activations: LoreTimeline["activations"] = [admission]) =>
  loreEffectsAt({ count, activations })
const activate = (
  count: number,
  messages = ["dog"],
  fields = {},
  activations: LoreTimeline["activations"] = [admission]
) =>
  matchLorebooks(
    [loreBook([loreEntry({ ...entry, ...fields })])],
    {
      messages,
      messageCount: count,
      effects: new Map([
        [loreEntryKey("synthetic", entry), effects(count, activations).get(key) ?? { sticky: false, cooldown: false }]
      ])
    },
    { budget: 25000, recursive: true },
    () => 0.5,
    (text) => text.length
  )

describe("causal lorebook timers", () => {
  it("uses the exclusive sticky end, then a protected cooldown window", () => {
    expect(effects(1).get(key)).toBeUndefined()
    expect(effects(2).get(key)).toEqual({ sticky: true, cooldown: true })
    expect(effects(3).get(key)).toEqual({ sticky: true, cooldown: false })
    expect(effects(4).get(key)).toEqual({ sticky: false, cooldown: true })
    const ended = { id: "version-b", at: 4, entries: [] }
    expect(effects(5, [admission, ended]).get(key)).toEqual({ sticky: false, cooldown: true })
    expect(effects(6, [admission, ended]).get(key)).toBeUndefined()
    expect(activate(4, ["cat"]).skipped[0]?.reason).toBe("cooldown")
  })

  it("cooldown alone starts at admission and expires at its exclusive end", () => {
    const history = [{ ...admission, entries: [{ key, sticky: 0, cooldown: 3 }] }]
    expect(effects(2, history).get(key)).toEqual({ sticky: false, cooldown: true })
    expect(effects(4, history).get(key)).toBeUndefined()
  })

  it("starts cooldown when the next evaluation observes an expired sticky interval", () => {
    expect(effects(12).get(key)).toEqual({ sticky: false, cooldown: true })
    expect(effects(14, [admission, { id: "observed", at: 12, entries: [] }]).get(key)).toBeUndefined()
  })

  it("sticky skips probability, keys and recursion flags, but respects delay and filters", () => {
    expect(
      activate(2, ["dog"], { probability: 0, delay_until_recursion: 8, exclude_recursion: true }).activated
    ).toHaveLength(1)
    expect(activate(2, ["dog"], { delay: 3 }).skipped[0]?.reason).toBe("delay")
    expect(
      activate(2, ["dog"], { character_filter: { is_exclude: false, names: ["someone"], tags: [] } }).skipped[0]?.reason
    ).toBe("character_filter")
  })

  it("a probability failure or budget rejection leaves no activation to start a timer", () => {
    const rejected = matchLorebooks(
      [loreBook([loreEntry({ keys: ["cat"], probability: 0, sticky: 3 })])],
      { messages: ["cat"] },
      { budget: 25000 },
      () => 0.5,
      (text) => text.length
    )
    expect(rejected.activated).toEqual([])
    const overBudget = matchLorebooks(
      [loreBook([entry])],
      { messages: ["cat"] },
      { budget: 1 },
      () => 0.5,
      (text) => text.length
    )
    expect(overBudget.activated).toEqual([])
    expect(overBudget.skipped[0]?.reason).toBe("budget")
    expect(effects(2, []).size).toBe(0)
    expect(activate(2, ["cat"], {}, []).activated).toHaveLength(1)
  })

  it("siblings read the same preceding state; their own activation cannot affect another swipe", () => {
    const before = { count: 2, activations: [admission] }
    const first = loreEffectsAt(before)
    loreEffectsAt({
      count: 3,
      activations: [...before.activations, { id: "swipe-1", at: 2, entries: admission.entries }]
    })
    expect(loreEffectsAt(before)).toEqual(first)
  })

  it("forks share their prefix but diverge by selected version receipts", () => {
    const common = { id: "root", at: 0, entries: [] }
    const a = loreEffectsAt({ count: 2, activations: [common, admission] })
    const b = loreEffectsAt({ count: 2, activations: [common, { ...admission, id: "version-b", entries: [] }] })
    expect(a.get(key)?.sticky).toBe(true)
    expect(b.has(key)).toBe(false)
    expect(loreEffectsAt({ count: 2, activations: [common, admission] })).toEqual(a)
  })

  it("shares checkpoints across thousands of messages and hundreds of branches", () => {
    const history = Array.from({ length: 3000 }, (_, i) => ({
      id: `scale-${i}`,
      at: i,
      entries: [] as typeof admission.entries
    }))
    history.push({ id: "shared-activation", at: 3000, entries: [{ key: "scale-key", sticky: 4, cooldown: 2 }] })
    expect(loreEffectsAt({ count: 3001, activations: history }).get("scale-key")?.sticky).toBe(true)
    for (let i = 0; i < 200; i++) {
      const branch = [...history, { id: `branch-${i}`, at: 3001, entries: [] }]
      expect(loreEffectsAt({ count: 3002, activations: branch }).get("scale-key")?.sticky).toBe(true)
    }
  })

  it("edits invalidate only that entry's effects", () => {
    expect(loreIdentity("synthetic", { ...entry, content: "edited" })).not.toBe(key)
    expect(loreIdentity("other-book", entry)).not.toBe(key)
  })
})
