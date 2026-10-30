import { expect, it } from "vitest"
import { applyDrafts, getAt, textField, valueField } from "@rp/shared/editing.ts"
import { editorTextFields, searchable } from "../src/features/editor/fields.ts"
import { emptyBook, emptyEntry } from "../src/features/editor/lorebookDefaults.ts"
import { entryMatches, lorebookFields, standaloneLorebookFields } from "../src/features/editor/lorebookFields.ts"
import { searchTexts } from "../src/features/editor/searchCore.ts"

it("registered embedded lore search writes valid drafts by uid and preserves other data", () => {
  const entry = { ...emptyEntry(42), comment: "Harbour", content: "Harbour tides", keys: ["harbour", "/harbour,a/iu"] }
  const doc = {
    character_book: {
      ...emptyBook(),
      entries: [emptyEntry(7), entry],
      extensions: { synthetic: { unchanged: true } }
    }
  }
  const undo = editorTextFields.register({ id: "card.embedded-lorebook", kind: "card", fields: lorebookFields })
  try {
    const fields = searchable("card", doc)
    const result = searchTexts({
      texts: fields.map((field) => field.text),
      find: "harbour",
      replace: "port",
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      preserveCase: false,
      max: 100
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches).toHaveLength(4)
    // Apply replacements as SearchDialog does, resolving each list from the current doc.
    let working = doc
    fields.forEach((field, index) => {
      const text = result.replaced![index]!
      if (text === field.text) return
      const path = field.inList?.path ?? field.path
      const before = getAt(working, path) as ReadonlyArray<string>
      const draft = field.inList
        ? { field: valueField(path), content: JSON.stringify(before.with(field.inList.index, text)) }
        : { field: textField(path), content: text }
      const applied = applyDrafts("card", working, [draft])
      expect(applied.problems).toEqual([])
      working = applied.doc as typeof doc
    })
    expect(working.character_book.entries[1]).toMatchObject({
      uid: 42,
      comment: "port",
      content: "port tides",
      keys: ["port", "/port,a/iu"]
    })
    expect(working.character_book.entries[0]).toEqual(emptyEntry(7))
    expect(working.character_book.extensions).toEqual(doc.character_book.extensions)
    const restore = editorTextFields.disable("card.embedded-lorebook")
    expect(searchable("card", doc)).toEqual([])
    restore()
    expect(searchable("card", doc)).toEqual(fields)
    const unoverride = editorTextFields.register({ id: "card.embedded-lorebook", kind: "card", fields: () => [] })
    expect(searchable("card", doc)).toEqual([])
    unoverride()
    expect(searchable("card", doc)).toEqual(fields)
  } finally {
    undo()
  }
})

it("a standalone lorebook's search covers the whole document, by uid, and the entry filter reads titles, keys and text", () => {
  const entry = {
    ...emptyEntry(9),
    comment: "Docks",
    content: "Tar and rope",
    keys: ["pier"],
    secondary_keys: ["gull"]
  }
  const doc = { ...emptyBook(), name: "Port book", entries: [entry, emptyEntry(3)] }
  const undo = editorTextFields.register({ id: "lorebook.entries", kind: "lorebook", fields: standaloneLorebookFields })
  try {
    const fields = searchable("lorebook", doc)
    expect(fields.map((field) => field.path)).toContainEqual(["entries", "uid=9", "content"])
    expect(fields.find((field) => field.text === "pier")).toMatchObject({
      path: ["entries", "uid=9", "keys", 0],
      inList: { path: ["entries", "uid=9", "keys"], index: 0 }
    })
    const applied = applyDrafts("lorebook", doc, [
      { field: textField(["entries", "uid=9", "content"]), content: "Tar, rope and salt" }
    ])
    expect(applied.problems).toEqual([])
    expect((applied.doc as typeof doc).entries[0]).toMatchObject({ uid: 9, content: "Tar, rope and salt" })
    // Card search is unaffected by the standalone contribution.
    expect(searchable("card", { character_book: doc })).toEqual([])
  } finally {
    undo()
  }
  expect(["docks", "PIER", "gull", "rope", ""].map((filter) => entryMatches(entry, filter))).toEqual([
    true,
    true,
    true,
    true,
    true
  ])
  expect(entryMatches(entry, "lantern")).toBe(false)
})
