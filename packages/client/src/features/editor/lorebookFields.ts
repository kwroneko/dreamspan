import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import type { Doc } from "@rp/shared/library.ts"
import type { Searchable } from "./fields.ts"

/** The embedded section's editable text, including entries whose forms aren't mounted. */
export function lorebookFields(doc: Doc): ReadonlyArray<Searchable> {
  const book = doc.character_book as LorebookDoc | undefined
  if (!book) return []
  return [
    ...(["name", "description"] as const).map((key) => ({
      path: ["character_book", key],
      label: `Embedded lorebook: ${key === "name" ? "Name" : "Description"}`,
      text: book[key]
    })),
    ...book.entries.flatMap((entry) => {
      const path = ["character_book", "entries", `uid=${entry.uid}`]
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
