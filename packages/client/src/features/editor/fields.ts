// What the editors call a document's fields: their labels, which hold text to search, and
// which differ between two versions of a document.
// The fields themselves are @dreamspan/shared/libraryText.ts's, which the library-wide search reads too.
import { canonicalJson, type FieldPath, parseField } from "@dreamspan/shared/editing.ts"
import type { Doc, EntityKind } from "@dreamspan/shared/library.ts"
import { builtinSearchable, fieldLabel, type Searchable } from "@dreamspan/shared/libraryText.ts"
import { makeRegistry } from "../../registry.ts"

export { fieldLabel, regexScriptFields, type Searchable } from "@dreamspan/shared/libraryText.ts"

/** A draft field's label. */
export const draftLabel = (kind: EntityKind, doc: Doc, field: string) => {
  const parsed = parseField(field)
  return parsed ? fieldLabel(kind, doc, parsed.path) : field
}

interface TextFieldContribution {
  readonly id: string
  readonly kind: EntityKind
  readonly fields: (doc: Doc) => ReadonlyArray<Searchable>
}

/** Feature-owned document sections contribute their text without coupling the search UI to them. */
export const editorTextFields = makeRegistry<TextFieldContribution>()

export const searchable = (
  kind: EntityKind,
  doc: Doc,
  contributions: ReadonlyArray<TextFieldContribution> = editorTextFields.list()
): ReadonlyArray<Searchable> => [
  ...builtinSearchable(kind, doc),
  ...contributions.flatMap((entry) => (entry.kind === kind ? entry.fields(doc) : []))
]

/** A field that differs between two versions of a document. */
export interface FieldChange {
  readonly path: FieldPath
  readonly before: unknown
  readonly after: unknown
}

const IDENTITIES = ["id", "identifier", "uid"] as const

const identityOf = (list: ReadonlyArray<unknown>) =>
  IDENTITIES.find((key) => list.every((element) => typeof element === "object" && element !== null && key in element))

/**
 * The fields that differ, per field: objects key by key, lists with identities element by
 * element, two levels down, and anything else whole.
 */
export const changedFields = (before: unknown, after: unknown, path: FieldPath = []): ReadonlyArray<FieldChange> => {
  if (canonicalJson(before) === canonicalJson(after)) return []
  const isRecord = (u: unknown): u is Record<string, unknown> =>
    typeof u === "object" && u !== null && !Array.isArray(u)
  if (path.length < 3 && isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    return keys.flatMap((key) => changedFields(before[key], after[key], [...path, key]))
  }
  if (path.length < 2 && Array.isArray(before) && Array.isArray(after)) {
    const key = identityOf([...before, ...after])
    if (key !== undefined) {
      const named = (list: ReadonlyArray<Record<string, unknown>>) =>
        new Map(list.map((element) => [`${key}=${String(element[key])}`, element]))
      const a = named(before as Array<Record<string, unknown>>)
      const b = named(after as Array<Record<string, unknown>>)
      const ids = [...new Set([...a.keys(), ...b.keys()])]
      const changes = ids.flatMap((id) => changedFields(a.get(id), b.get(id), [...path, id]))
      // Reordered with nothing else changed: the list's order is the change.
      return changes.length > 0 ? changes : [{ path, before, after }]
    }
  }
  return [{ path, before, after }]
}
