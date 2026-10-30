import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import type { Doc } from "@rp/shared/library.ts"
import type { Searchable } from "./fields.ts"

/** A book's editable text at `root`, including entries whose forms aren't mounted. */
const bookFields = (book: LorebookDoc | undefined, root: FieldPath, bookLabel: string): ReadonlyArray<Searchable> => {
  if (!book) return []
  return [
    ...(["name", "description"] as const).map((key) => ({
      path: [...root, key],
      label: `${bookLabel}: ${key === "name" ? "Name" : "Description"}`,
      text: book[key]
    })),
    ...book.entries.flatMap((entry) => {
      const path = [...root, "entries", `uid=${entry.uid}`]
      const title = `Lorebook entry ${entry.comment ? `“${entry.comment}”` : entry.uid}`
      return [
        ...(["comment", "content", "outlet_name", "group"] as const).map((key) => ({
          path: [...path, key],
          label: `${title}: ${{ comment: "Title", content: "Content", outlet_name: "Outlet name", group: "Inclusion group" }[key]}`,
          text: entry[key]
        })),
        ...(["keys", "secondary_keys"] as const).flatMap((key) =>
          entry[key].map((text, index) => ({
            path: [...path, key, index],
            label: `${title}: ${key === "keys" ? "Primary" : "Secondary"} key ${index + 1}`,
            text,
            inList: { path: [...path, key], index }
          }))
        )
      ]
    })
  ]
}

/** The card's embedded section. */
export const lorebookFields = (doc: Doc): ReadonlyArray<Searchable> =>
  bookFields(doc.character_book as LorebookDoc | undefined, ["character_book"], "Embedded lorebook")

/** A standalone lorebook: the document is the book. */
export const standaloneLorebookFields = (doc: Doc): ReadonlyArray<Searchable> =>
  bookFields(doc as unknown as LorebookDoc, [], "Lorebook")

/** Whether an entry's title, keys or text contain the filter, ignoring case. */
export const entryMatches = (entry: LorebookEntry, filter: string) => {
  const needle = filter.trim().toLowerCase()
  if (needle === "") return true
  return [entry.comment, entry.content, ...entry.keys, ...entry.secondary_keys].some((text) =>
    text.toLowerCase().includes(needle)
  )
}
