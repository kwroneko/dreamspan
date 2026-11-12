// A library document's text fields (libraryText.ts), as both the editors' and the library-wide
// search and replace read them: a card's built-in fields, regex scripts and embedded lorebook;
// a lorebook's entries; a note's title and content; labels as the editors show them.
import { Effect } from "effect"
import { libraryReplaceKinds } from "../src/libraryText.ts"
import { describe, expect, it } from "vitest"
import { newCardDoc } from "../src/editing.ts"
import type { Doc } from "../src/library.ts"
import { libraryEditTitle } from "../src/libraryReplace.ts"
import { libraryTextFields } from "../src/libraryText.ts"

const book = {
  name: "Harbour lore",
  description: "",
  entries: [
    {
      uid: 7,
      comment: "Lighthouse",
      content: "{{char}} keeps it.",
      outlet_name: "",
      group: "",
      keys: ["beacon", "lamp"],
      secondary_keys: []
    }
  ]
}

describe("library text fields", () => {
  it("lists a card's fields, its regex scripts and its embedded lorebook, with their labels", () => {
    const doc = {
      ...newCardDoc("Mira"),
      description: "{{char}} waves.",
      alternate_greetings: ["Hello", "Hi"],
      regex: [{ id: "r1", name: "Trim", find_regex: "x", replace_string: "y" }],
      character_book: book
    } as unknown as Doc
    const fields = libraryTextFields("card", doc)
    const label = (path: ReadonlyArray<string | number>) =>
      fields.find((f) => JSON.stringify(f.path) === JSON.stringify(path))?.label
    expect(label(["description"])).toBe("Description")
    expect(label(["alternate_greetings", 1])).toBe("Alternate greetings 2")
    expect(label(["regex", "id=r1", "find_regex"])).toBe("Regex script “Trim”: Find regex")
    expect(label(["character_book", "entries", "uid=7", "content"])).toBe("Lorebook entry “Lighthouse”: Content")
    expect(label(["character_book", "entries", "uid=7", "keys", 1])).toBe("Lorebook entry “Lighthouse”: Primary key 2")
    expect(fields.every((f) => typeof f.text === "string")).toBe(true)
    expect(libraryEditTitle({ find: "{{char}}", replace: "Mira" })).toBe(
      "Replaced “{{char}}” with “Mira” across the library"
    )
  })

  it("lists a lorebook's entries and a note's title and content", () => {
    const lore = libraryTextFields("lorebook", book as unknown as Doc)
    expect(lore.map((f) => f.text)).toContain("{{char}} keeps it.")
    expect(lore.find((f) => f.text === "Harbour lore")?.label).toBe("Lorebook: Name")
    const note = libraryTextFields("note", { title: "Tide", content: "Ask {{char}}." } as Doc)
    expect(note.map((f) => f.label)).toEqual(["Title", "Content"])
  })
})

it("registered library kinds supply fields, labels and validation, and can be disabled", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* libraryReplaceKinds.register({
          id: "preset_overlay",
          one: "overlay",
          many: "Overlays",
          fields: (doc) => [{ path: ["extra"], label: "Plugin text", text: String(doc.extra) }],
          validate: (doc) => ({ ok: true as const, doc: doc as Doc })
        })
        expect(libraryTextFields("preset_overlay", { extra: "hello" })).toEqual([
          { path: ["extra"], label: "Plugin text", text: "hello" }
        ])
        expect(libraryReplaceKinds.list().map((k) => k.id)).toContain("preset_overlay")
        yield* libraryReplaceKinds.disable("preset_overlay")
        expect(libraryTextFields("preset_overlay", { extra: "hello" })).toEqual([])
      })
    )
  )
})
