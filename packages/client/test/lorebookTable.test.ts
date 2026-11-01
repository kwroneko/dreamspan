import { describe, expect, it } from "vitest"
import { emptyEntry } from "../src/features/editor/lorebookDefaults.ts"
import { fieldLabel } from "../src/features/editor/fields.ts"
import {
  arrangeEntries,
  type LorebookSort,
  positionValue,
  strategyOf,
  uidOf
} from "../src/features/editor/lorebookTable.ts"

const entry = (uid: number, comment: string, more: Partial<ReturnType<typeof emptyEntry>> = {}) => ({
  ...emptyEntry(uid),
  comment,
  ...more
})

const entries = [
  entry(1, "Harbor", { order: 10, keys: ["dock"], content: "Ships rest here." }),
  entry(2, "Castle", { order: 30, enabled: false, keys: ["keep"] }),
  entry(3, "Market", { order: 20, secondary_keys: ["coin"] })
]
const byOrder: LorebookSort = { id: "order", order: 1, label: "Order", compare: (a, b) => b.order - a.order }
const facts = (e: (typeof entries)[number], index: number) => ({
  index,
  title: e.comment,
  content: e.content,
  changed: false
})

describe("the lorebook table", () => {
  it("sorts, filters by enabled, and searches titles, keys and content", () => {
    const arrange = (options: Partial<Parameters<typeof arrangeEntries>[1]>) =>
      arrangeEntries(entries, { query: "", enabled: "all", sort: byOrder, facts, ...options })
    expect(arrange({})).toEqual([2, 3, 1])
    expect(arrange({ enabled: "on" })).toEqual([3, 1])
    expect(arrange({ enabled: "off" })).toEqual([2])
    expect(arrange({ query: "ships" })).toEqual([1])
    expect(arrange({ query: "COIN" })).toEqual([3])
    expect(arrange({ query: "keep", enabled: "on" })).toEqual([])
    // Entries just added lead, newest first, even where the filter would hide them.
    expect(arrange({ pinned: [2], enabled: "on" })).toEqual([2, 3, 1])
    expect(arrange({ pinned: [1, 2] })).toEqual([1, 2, 3])
    // A pinned entry since removed is skipped.
    expect(arrange({ pinned: [9, 1] })).toEqual([1, 2, 3])
    // Without a sort, the book's own order.
    expect(arrange({ sort: undefined })).toEqual([1, 2, 3])
  })

  it("names positions and strategies as ST does", () => {
    expect(positionValue(entry(1, "", { position: "at_depth", role: "user" }))).toBe("at_depth:user")
    expect(positionValue(entry(1, "", { position: "an_top", role: "user" }))).toBe("at_depth:system")
    expect(strategyOf(entry(1, "", { constant: true, vectorized: true }))).toBe("constant")
    expect(strategyOf(entry(1, "", { vectorized: true }))).toBe("vectorized")
    expect(strategyOf(entry(1, ""))).toBe("normal")
    expect(uidOf("uid=42")).toBe(42)
    expect(uidOf("identifier=42")).toBeNull()
  })

  it("labels a changed entry by its title in the save's diff", () => {
    const book = { entries }
    expect(fieldLabel("lorebook", book, ["entries", "uid=3", "order"])).toBe("Entry “Market”: Order")
    expect(fieldLabel("lorebook", book, ["entries", 0, "comment"])).toBe("Entry “Harbor”: Title")
    expect(fieldLabel("lorebook", book, ["entries", "uid=1", "probability"])).toBe("Entry “Harbor”: Trigger %")
    expect(fieldLabel("lorebook", { entries: [entry(9, "")] }, ["entries", 0])).toBe("Entries 1")
    // A deleted entry is named from the saved book.
    expect(fieldLabel("lorebook", { entries: [] }, ["entries", "uid=2"], book)).toBe("Entry “Castle”")
    expect(fieldLabel("lorebook", { entries: [] }, ["entries", "uid=2"])).toBe("Entry 2")
    // A card's embedded book, as a lorebook.
    const card = { character_book: book }
    expect(fieldLabel("card", card, ["character_book", "entries", "uid=3", "constant"])).toBe(
      "Lorebook: Entry “Market”: Strategy (constant)"
    )
    expect(fieldLabel("card", { character_book: { entries: [] } }, ["character_book", "entries", "uid=1"], card)).toBe(
      "Lorebook: Entry “Harbor”"
    )
    expect(fieldLabel("card", card, ["character_book", "name"])).toBe("Lorebook: Name")
    // Other documents keep their plain field names.
    expect(fieldLabel("preset", { prompts: [] }, ["prompts", "identifier=x", "probability"])).toBe(
      "Prompt x: Probability"
    )
  })
})
