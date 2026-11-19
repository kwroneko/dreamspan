// The unsaved fields of an entry by name, for the export's question: "Description", "Prompt
// “Main Prompt”: content". A preset's held changes are one line. Each name once, in order.
import { isHeldField, parseField } from "@dreamspan/shared/editing.ts"
import type { Doc, EntityKind } from "@dreamspan/shared/library.ts"
import { fieldLabel } from "../editor/fields.ts"

export const HELD_LABEL = "Prompts or lorebooks added, deleted or moved"

export const unsavedFieldNames = (
  kind: EntityKind,
  working: Doc,
  head: Doc,
  fields: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const names = fields.flatMap((field) => {
    if (isHeldField(field)) return [HELD_LABEL]
    const parsed = parseField(field)
    return parsed ? [fieldLabel(kind, working, parsed.path, head)] : []
  })
  return [...new Set(names)]
}
