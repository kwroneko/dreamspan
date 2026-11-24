// A workshop's change rows (spec/WORKSHOP-CARDS.md §7, features/workshop/changeRows.ts): one row
// per item a turn changed, the revision pair its change view compares, the count, "changed
// since", and which message ends a turn.
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import { describe, expect, it } from "vitest"
import { changedFields } from "../src/features/editor/fields.ts"
import {
  changeCount,
  changedNames,
  changedSince,
  cardFileChangeTarget,
  changeViewHref,
  changeViewTarget,
  itemChanges,
  itemUndone,
  turnEndingAt
} from "../src/features/workshop/changeRows.ts"
import type { RolloutEffect } from "../src/features/workshop/effects.ts"

let seq = 0
const effect = (
  fields: Partial<RolloutEffect> & Pick<RolloutEffect, "kind" | "targetId" | "title">
): RolloutEffect => ({
  rolloutId: "run",
  toolCallId: `call${++seq}`,
  seq: 0,
  targetKind: "entity",
  undo: null,
  undoResult: null,
  undoneAt: null,
  createdAt: seq,
  ...fields
})
const revise = (entity: string, name: string, before: string, head: string) =>
  effect({
    kind: "library.revise",
    targetId: entity,
    title: `Edited the card ${name}`,
    undo: { refId: `ref-${entity}`, before, head }
  })
const create = (entity: string, kind: string, name: string, head: string) =>
  effect({
    kind: "library.create",
    targetId: entity,
    title: `Created the ${kind} ${name}`,
    undo: { refId: `ref-${entity}`, head }
  })
/** Newest first, as `ListVersionEffects` lists them. */
const listed = (...oldestFirst: ReadonlyArray<RolloutEffect>) => [...oldestFirst].reverse()

describe("change rows", () => {
  it("makes one row per item, in the order first changed, from the first change's before to the last's head", () => {
    const rows = itemChanges(
      listed(
        revise("mara", "Mara Quill", "r1", "r2"),
        create("ove", "card", "Ove Brekke", "o1"),
        revise("mara", "Mara Quill", "r2", "r3"),
        effect({ kind: "chat.create", targetId: "chat", targetKind: "chat", title: "Started the chat X" })
      )
    )
    expect(rows.map((r) => [r.label, r.kind, r.created, r.from, r.to, r.effects.length])).toEqual([
      ["Mara Quill", "card", false, "r1", "r3", 2],
      ["Ove Brekke", "card", true, null, "o1", 1]
    ])
    // Newest first, so an undo runs back through them in order.
    expect(rows[0]!.effects.map((e) => e.undo?.head)).toEqual(["r3", "r2"])
  })

  it("leaves out notes made with a card, and counts an item made then edited as made", () => {
    const rows = itemChanges(
      listed(
        create("book", "lorebook", "Skerry Lore", "b1"),
        create("note", "note", "Ove's note", "n1"),
        effect({
          kind: "library.revise",
          targetId: "book",
          title: "Edited the lorebook Skerry Lore",
          undo: { refId: "ref-book", before: "b1", head: "b2" }
        })
      )
    )
    expect(rows.map((r) => [r.label, r.kind, r.created, r.from, r.to])).toEqual([
      ["Skerry Lore", "lorebook", true, null, "b2"]
    ])
  })

  it("is undone once every change of the item is", () => {
    const [row] = itemChanges(
      listed(revise("mara", "Mara", "r1", "r2"), { ...revise("mara", "Mara", "r2", "r3"), undoneAt: 5 })
    )
    expect(itemUndone(row!)).toBe(false)
    const [done] = itemChanges(listed({ ...revise("mara", "Mara", "r1", "r2"), undoneAt: 6 }))
    expect(itemUndone(done!)).toBe(true)
  })

  it("counts fields, and a lorebook's entries by what happened to them", () => {
    const card = changedFields(
      { name: "Mara", description: "a", scenario: "b" },
      { name: "Mara", description: "a2", scenario: "b2", first_mes: "hi" }
    )
    expect(changeCount("card", card)).toBe("3 fields")
    expect(changeCount("card", changedFields({ description: "a" }, { description: "b" }))).toBe("1 field")
    const entry = (uid: number, content: string) => ({ uid, content, keys: ["k"] })
    const book = changedFields(
      { name: "Lore", entries: [entry(1, "x"), entry(2, "y")] },
      { name: "Lore", entries: [entry(1, "x2"), entry(2, "y"), entry(3, "z"), entry(4, "w")] }
    )
    expect(changeCount("lorebook", book)).toBe("2 entries added, 1 changed")
    expect(changeCount("lorebook", changedFields({ entries: [entry(1, "x")] }, { entries: [] }))).toBe(
      "1 entry removed"
    )
  })

  it("names the changed fields, the first six and how many more", () => {
    expect(changedNames(["Description", "Scenario", "Description"])).toBe("Description, Scenario")
    expect(changedNames(["a", "b", "c", "d", "e", "f", "g", "h"])).toBe("a, b, c, d, e, f and 2 more")
  })

  it("says who changed the item since the turn, if anyone did", () => {
    const rev = (id: string, origin: string) => ({ id, origin })
    expect(changedSince([rev("r3", "agent"), rev("r2", "user")], "r3")).toBe(null)
    expect(changedSince([rev("r5", "generation"), rev("r3", "agent")], "r3")).toBe(null)
    expect(changedSince([rev("r4", "agent"), rev("r3", "agent")], "r3")).toBe("reply")
    expect(changedSince([rev("r5", "agent"), rev("r4", "user"), rev("r3", "agent")], "r3")).toBe("you")
    expect(changedSince([rev("r9", "user")], "r3")).toBe("you")
  })

  it("round-trips the change view's URL", () => {
    const reply = { chatId: "c1", slotId: "s9", versionId: "v4" }
    const href = changeViewHref({ refId: "ref1", from: "r1", to: "r3" }, reply)
    expect(changeViewTarget(new URL(href, "http://x.invalid"))).toEqual({ refId: "ref1", from: "r1", to: "r3", reply })
    const made = changeViewHref({ refId: "ref1", from: null, to: "r1" }, reply)
    expect(changeViewTarget(new URL(made, "http://x.invalid"))?.from).toBe(null)
    expect(changeViewTarget(new URL("/library/ref1", "http://x.invalid"))).toBe(null)
  })

  it("makes one row per card file a turn edited, with its fields before the first edit and after the last", () => {
    const edit = (before: string | null, after: string, card: object) =>
      effect({
        kind: "file.edit",
        targetKind: "file",
        targetId: "/files/w/wren.png",
        title: "Edited the card file /files/w/wren.png",
        undo: { path: "/files/w/wren.png", before, after, inode: 1, card }
      })
    const rows = itemChanges(
      listed(
        edit("v1", "h2", { name: "Wren", format: "png", before: { description: "A" }, after: { description: "B" } }),
        // A plain file edit isn't a row.
        effect({
          kind: "file.edit",
          targetKind: "file",
          targetId: "/files/w/notes.txt",
          title: "Edited /files/w/notes.txt"
        }),
        edit("v2", "h3", {
          name: "Wren Hollow",
          format: "png",
          before: { description: "B", name: "Wren" },
          after: { description: "C", name: "Wren Hollow" }
        })
      )
    )
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect([row!.label, row!.kind, row!.from, row!.to, row!.effects.length]).toEqual([
      "Wren Hollow",
      "card",
      "v1",
      "h3",
      2
    ])
    expect(row!.file).toEqual({
      path: "/files/w/wren.png",
      before: { description: "A", name: "Wren" },
      after: { description: "C", name: "Wren Hollow" }
    })
    const reply = { chatId: "c1", slotId: "s9", versionId: "v4" }
    const href = changeViewHref(row!, reply)
    expect(cardFileChangeTarget(new URL(href, "http://x.invalid"))).toEqual({
      path: "/files/w/wren.png",
      to: "h3",
      reply
    })
    expect(changeViewTarget(new URL(href, "http://x.invalid"))).toBe(null)
  })
})

describe("turn boundaries", () => {
  const at = (slotId: string, side: "user" | "assistant") => ({ slotId, side }) as unknown as PathEntry
  const path = [at("u1", "user"), at("a1", "assistant"), at("a2", "assistant"), at("u2", "user"), at("a3", "assistant")]

  it("ends a turn at its last reply, from its first", () => {
    const turn = turnEndingAt(path, "a2")
    expect([turn?.first.slotId, turn?.last.slotId]).toEqual(["a1", "a2"])
    expect(turnEndingAt(path, "a3")?.first.slotId).toBe("a3")
  })

  it("has no turn ending at a reply followed by another, or at a user message", () => {
    expect(turnEndingAt(path, "a1")).toBe(null)
    expect(turnEndingAt(path, "u2")).toBe(null)
    expect(turnEndingAt(path, "missing")).toBe(null)
  })
})
