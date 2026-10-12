// Editing library documents (ARCHITECTURE.md "Editing the library"; DESIGN §4, §6.2). Each
// field the user edits is a draft keyed by its path in the document, so every field keeps
// its own undo history on the server. The working document is the ref's head with every
// draft applied; the client builds it to show the diff, and the writer builds it again,
// from the drafts it holds, to commit a revision. Both use the functions here.
import type { EntityId } from "./chat.ts"
import { Result, Schema, SchemaIssue } from "effect"
import { CARD_SCHEMA_VERSION, CardDoc } from "./docs/card.ts"
import { NOTE_SCHEMA_VERSION, NoteDoc } from "./docs/note.ts"
import { PresetDoc } from "./docs/preset.ts"
import type { Doc, EntityKind } from "./library.ts"

export type FieldPath = ReadonlyArray<string | number>

/**
 * A draft's field: a text at a path, or any JSON value at a path (a number, a switch, a list,
 * a new prompt). Paths name array elements by identity where they have one (`identifier=main`,
 * as merge conflicts do), so reordering doesn't move a draft to another element.
 */
export interface EditField {
  readonly kind: "text" | "value"
  readonly path: FieldPath
}

export const textField = (path: FieldPath) => JSON.stringify(path)
export const valueField = (path: FieldPath) => `=${JSON.stringify(path)}`

/** Keys that could reach a prototype if a later assignment met them. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"])
const IDENTITY = /^(id|identifier|uid)=(.+)$/s
const MAX_PATH = 8
const MAX_SEGMENT = 300

/** A field as the client named it, or null if it isn't one (only the canonical spelling counts). */
export const parseField = (field: string): EditField | null => {
  const kind = field.startsWith("=") ? "value" : "text"
  let path: unknown
  try {
    path = JSON.parse(kind === "value" ? field.slice(1) : field)
  } catch {
    return null
  }
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH) return null
  const valid = path.every((segment: unknown) =>
    typeof segment === "number"
      ? Number.isSafeInteger(segment) && segment >= 0
      : typeof segment === "string" && segment.length > 0 && segment.length <= MAX_SEGMENT && !FORBIDDEN.has(segment)
  )
  if (!valid) return null
  const parsed = { kind, path: path as FieldPath } as const
  return (kind === "value" ? valueField(parsed.path) : textField(parsed.path)) === field ? parsed : null
}

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

const identityOf = (segment: string) => {
  const match = IDENTITY.exec(segment)
  return match ? { key: match[1]!, value: match[2]! } : null
}

const matches = (element: unknown, id: { key: string; value: string }) =>
  isObject(element) && Object.hasOwn(element, id.key) && String(element[id.key]) === id.value

const step = (container: unknown, segment: string | number): unknown => {
  if (Array.isArray(container)) {
    if (typeof segment === "number") return container[segment]
    const id = identityOf(segment)
    return id ? container.find((element) => matches(element, id)) : undefined
  }
  if (isObject(container) && typeof segment === "string") {
    return Object.hasOwn(container, segment) ? container[segment] : undefined
  }
  return undefined
}

/** The value at `path`, or undefined where there's none. Own keys only. */
export const getAt = (doc: unknown, path: FieldPath): unknown => path.reduce(step, doc)

/** Whether a JSON value has a key that could reach a prototype, at any depth. */
const hasForbiddenKey = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(hasForbiddenKey)
    : isObject(value) && Object.keys(value).some((key) => FORBIDDEN.has(key) || hasForbiddenKey(value[key]))

/**
 * Puts `value` at `path` in `root`, in place. In an array, null at an element removes it,
 * and an identity no element has adds one at the end. Returns why it can't, or null.
 */
const setAt = (root: unknown, path: FieldPath, value: unknown): string | null => {
  const parent = getAt(root, path.slice(0, -1))
  const last = path.at(-1)!
  if (Array.isArray(parent)) {
    if (typeof last === "number") {
      if (last > parent.length || (last === parent.length && value === null)) return "there's no such element"
      if (value === null) parent.splice(last, 1)
      else parent[last] = value
      return null
    }
    const id = identityOf(last)
    if (id === null) return "a list's elements are named by their id"
    const index = parent.findIndex((element) => matches(element, id))
    if (value === null) {
      if (index >= 0) parent.splice(index, 1)
      return null
    }
    if (!matches(value, id)) return "the element doesn't have the id its path names"
    if (index >= 0) parent[index] = value
    else parent.push(value)
    return null
  }
  if (isObject(parent) && typeof last === "string") {
    parent[last] = value
    return null
  }
  return "the document has no place for it"
}

/** Top-level fields a draft never changes: each changes through its own action, or never. */
const PROTECTED: Partial<Record<EntityKind, ReadonlySet<string>>> = {
  card: new Set(["schema_version", "avatar_media_id", "asset_media_ids"]),
  preset: new Set(["schema_version", "regex_approved"]),
  note: new Set(["schema_version", "owner"])
}

export interface DraftContent {
  readonly field: string
  readonly content: string
}

interface FieldProblem {
  readonly field: string
  readonly message: string
}

/**
 * The head with the drafts applied: values first, shallowest first, then texts, so a text
 * in a prompt that a value draft added lands in it. The head isn't changed.
 */
export const applyDrafts = (kind: EntityKind, head: Doc, drafts: ReadonlyArray<DraftContent>) => {
  const doc = structuredClone(head)
  const problems: Array<FieldProblem> = []
  const parsed = drafts.flatMap((draft) => {
    const field = parseField(draft.field)
    if (field === null) {
      problems.push({ field: draft.field, message: "This isn't a field of a document." })
      return []
    }
    if (PROTECTED[kind]?.has(String(field.path[0]))) {
      problems.push({ field: draft.field, message: "This changes through its own action, not an edit." })
      return []
    }
    return [{ ...field, draft }]
  })
  const ordered = parsed.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "value" ? -1 : 1) : a.path.length - b.path.length
  )
  for (const { kind: fieldKind, path, draft } of ordered) {
    let value: unknown = draft.content
    if (fieldKind === "value") {
      try {
        value = JSON.parse(draft.content)
      } catch {
        problems.push({ field: draft.field, message: "This value isn't valid." })
        continue
      }
      if (hasForbiddenKey(value)) {
        problems.push({ field: draft.field, message: "This value has a key that isn't allowed." })
        continue
      }
    } else {
      const current = getAt(doc, path)
      if (current !== undefined && typeof current !== "string") {
        problems.push({ field: draft.field, message: "This field isn't text." })
        continue
      }
    }
    const refused = setAt(doc, path, value)
    if (refused !== null) problems.push({ field: draft.field, message: `This field can't be changed: ${refused}.` })
  }
  return { doc, problems }
}

/**
 * `doc` with values put at paths, protected fields included: for a merge the user resolved
 * by hand, which the server validates whole. Returns null if a path has no place.
 */
export const withValues = (doc: Doc, values: ReadonlyArray<{ readonly path: FieldPath; readonly value: unknown }>) => {
  const copy = structuredClone(doc)
  return values.every(({ path, value }) => setAt(copy, path, value) === null) ? copy : null
}

const SCHEMAS = { card: CardDoc, preset: PresetDoc, note: NoteDoc } as const

const isEditable = (kind: EntityKind): kind is keyof typeof SCHEMAS => Object.hasOwn(SCHEMAS, kind)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * The document as its kind's schema reads it, so what's stored is what the schema allows;
 * keys the schema doesn't know are dropped. Problems name their paths, at most 20.
 */
export const validateDoc = (
  kind: EntityKind,
  doc: unknown
): { readonly ok: true; readonly doc: Doc } | { readonly ok: false; readonly problems: ReadonlyArray<string> } => {
  if (!isEditable(kind)) return { ok: false, problems: [`A ${kind} can't be edited yet.`] }
  const result = Schema.decodeUnknownResult(SCHEMAS[kind] as Schema.Codec<unknown, unknown>)(doc)
  if (Result.isSuccess(result)) return { ok: true, doc: result.success as Doc }
  return {
    ok: false,
    problems: formatIssues(result.failure.issue)
      .issues.slice(0, 20)
      .map((issue) => `${(issue.path ?? []).map(String).join(".") || "the document"}: ${issue.message}`)
  }
}

/** JSON with object keys sorted, for comparing values whatever their key order. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isObject(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, inner[key]])
        )
      : inner
  ) ?? "undefined"

/**
 * Whether a preset keeps its regex approval through a change that isn't the user's own
 * typing (a merge, a restored revision): only if it had it, and the scripts are the ones
 * it had (DESIGN §11). Approval is gained only by approving.
 */
export const keepsRegexApproval = (ours: Doc, next: Doc) =>
  ours.regex_approved === true && canonicalJson(ours.regex) === canonicalJson(next.regex)

/** A card made from scratch: its name, and every field empty. */
export const newCardDoc = (name: string): CardDoc => ({
  schema_version: CARD_SCHEMA_VERSION,
  name,
  description: "",
  personality: "",
  scenario: "",
  first_mes: "",
  mes_example: "",
  alternate_greetings: [],
  group_only_greetings: [],
  system_prompt: "",
  post_history_instructions: "",
  creator_notes: "",
  tags: [],
  creator: "",
  character_version: "",
  avatar_media_id: null,
  modules: [],
  extensions: {}
})

/** A new note on a card: in-chat at ST's default depth for its Character's Note. */
export const newCardNote = (card: EntityId, title: string): NoteDoc => ({
  schema_version: NOTE_SCHEMA_VERSION,
  title,
  content: "",
  placement: { mode: "depth", depth: 4, role: "system" },
  owner: { card },
  exportable: true,
  agent_editable: false
})
