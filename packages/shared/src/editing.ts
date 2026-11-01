// Editing library documents (ARCHITECTURE.md "Editing the library"; DESIGN §4, §6.2). Each
// field the user edits is a draft keyed by its path in the document, so every field keeps
// its own undo history on the server. The working document is the ref's head with every
// draft applied; the client builds it to show the diff, and the writer builds it again,
// from the drafts it holds, to commit a revision. Both use the functions here.
import type { ChatId, EntityId } from "./chat.ts"
import { Result, Schema, SchemaIssue } from "effect"
import { CARD_SCHEMA_VERSION, CardDoc } from "./docs/card.ts"
import { LorebookDoc } from "./docs/lorebook.ts"
import { NOTE_SCHEMA_VERSION, NoteDoc, upgradedCondition } from "./docs/note.ts"
import { withMain } from "./presetOrder.ts"
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

/**
 * A preset's structural changes held behind its unsaved bar (owner, 2026-11-01): prompts moved
 * or deleted, as JSON (`HeldChanges` in the client's `features/editor/heldOrder.ts`). It's an editor field like the others,
 * with a draft and its history, but not a field of the document: applying drafts, a save and a
 * generation's checkpoint leave it out, and only the bar's Save applies it.
 */
export const HELD_FIELD = textField(["~held"])
export const isHeldField = (field: string) => field === HELD_FIELD

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

/** Why a value can't go at a path. `orphan`: what it was in is gone (deleted, or never there). */
interface Refusal {
  readonly reason: string
  readonly orphan: boolean
}

/**
 * Puts `value` at `path` in `root`, in place. Undefined removes what's there; in a list, so
 * does null, and an identity no element has adds one at the end. Returns why it can't, or null.
 */
const setAt = (root: unknown, path: FieldPath, value: unknown): Refusal | null => {
  const parent = getAt(root, path.slice(0, -1))
  const last = path.at(-1)!
  const remove = value === undefined || (value === null && Array.isArray(parent))
  if (Array.isArray(parent)) {
    if (typeof last === "number") {
      if (last > parent.length || (last === parent.length && remove)) {
        return { reason: "there's no such element", orphan: false }
      }
      if (remove) parent.splice(last, 1)
      else parent[last] = value
      return null
    }
    const id = identityOf(last)
    if (id === null) return { reason: "a list's elements are named by their id", orphan: false }
    const index = parent.findIndex((element) => matches(element, id))
    if (remove) {
      if (index >= 0) parent.splice(index, 1)
      return null
    }
    if (!matches(value, id)) return { reason: "the element doesn't have the id its path names", orphan: false }
    if (index >= 0) parent[index] = value
    else parent.push(value)
    return null
  }
  if (isObject(parent) && typeof last === "string") {
    if (remove) delete parent[last]
    else parent[last] = value
    return null
  }
  return { reason: "the document has no place for it", orphan: parent === undefined }
}

/** Lists whose elements have ids, by kind: a path names their elements by id, never by index. */
const IDENTIFIED: Partial<Record<EntityKind, ReadonlyArray<string>>> = {
  card: ["modules", "character_book/entries", "regex"],
  preset: ["prompts", "order", "regex", "lorebooks"]
}

const IDENTITY_KEYS = ["id", "identifier", "uid"] as const

/** Whether a path goes into a list with ids by an index, where a reorder would move it to another element. */
const indexIntoIdentified = (kind: EntityKind, doc: unknown, path: FieldPath) =>
  path.some((segment, at) => {
    if (typeof segment !== "number") return false
    const list = getAt(doc, path.slice(0, at))
    const known = IDENTIFIED[kind]?.includes(path.slice(0, at).join("/")) ?? false
    const identified =
      Array.isArray(list) &&
      list.length > 0 &&
      IDENTITY_KEYS.some((key) => list.every((element) => isObject(element) && Object.hasOwn(element, key)))
    return known || identified
  })

/** Top-level fields a draft never changes: each changes through its own action, or never. */
const PROTECTED: Partial<Record<EntityKind, ReadonlySet<string>>> = {
  card: new Set(["schema_version", "avatar_media_id", "avatar_crop", "asset_media_ids", "regex_approved"]),
  preset: new Set(["schema_version", "regex_approved"]),
  // A slot's link changes only by picking, saving as or unlinking a shared note.
  note: new Set(["schema_version", "owner", "link"])
}

/**
 * Protected fields (above) of `doc` that hold neither side's value: a resolved merge can keep
 * one side's avatar or owner, never put another there.
 */
export const protectedChanges = (kind: EntityKind, doc: Doc, sides: ReadonlyArray<Doc>) =>
  [...(PROTECTED[kind] ?? [])].filter(
    (key) => !sides.some((side) => canonicalJson(side[key]) === canonicalJson(doc[key]))
  )

export interface DraftContent {
  readonly field: string
  readonly content: string
}

interface FieldProblem {
  readonly field: string
  readonly message: string
  /** What the field was in is gone, such as a deleted prompt's text. */
  readonly orphan: boolean
}

/**
 * The head with the drafts applied: values first, shallowest first, then texts, so a text
 * in a prompt that a value draft added lands in it. The head isn't changed.
 */
export const applyDrafts = (kind: EntityKind, head: Doc, drafts: ReadonlyArray<DraftContent>) => {
  const doc = structuredClone(head)
  const problems: Array<FieldProblem> = []
  const parsed = drafts.flatMap((draft) => {
    if (isHeldField(draft.field)) return []
    const field = parseField(draft.field)
    if (field === null) {
      problems.push({ field: draft.field, message: "This isn't a field of a document.", orphan: false })
      return []
    }
    if (PROTECTED[kind]?.has(String(field.path[0]))) {
      problems.push({ field: draft.field, message: "This changes through its own action, not an edit.", orphan: false })
      return []
    }
    return [{ ...field, draft }]
  })
  const ordered = parsed.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "value" ? -1 : 1) : a.path.length - b.path.length
  )
  for (const { kind: fieldKind, path, draft } of ordered) {
    const problem = (message: string, orphan = false) => problems.push({ field: draft.field, message, orphan })
    if (indexIntoIdentified(kind, doc, path)) {
      problem("This names a list's element by its place; elements with ids are named by their id.")
      continue
    }
    let value: unknown = draft.content
    if (fieldKind === "value") {
      try {
        value = draft.content === "undefined" ? undefined : JSON.parse(draft.content)
      } catch {
        problem("This value isn't valid.")
        continue
      }
      if (hasForbiddenKey(value)) {
        problem("This value has a key that isn't allowed.")
        continue
      }
    } else {
      const current = getAt(doc, path)
      if (current !== undefined && typeof current !== "string") {
        problem("This field isn't text.")
        continue
      }
    }
    const refused = setAt(doc, path, value)
    if (refused !== null) problem(`This field can't be changed: ${refused.reason}.`, refused.orphan)
  }
  return { doc, problems }
}

/**
 * `doc` with values put at paths, protected fields included: for a merge the user resolved
 * by hand, which the server validates whole. Undefined removes. Returns null if a path has no place.
 */
export const withValues = (doc: Doc, values: ReadonlyArray<{ readonly path: FieldPath; readonly value: unknown }>) => {
  const copy = structuredClone(doc)
  return values.every(({ path, value }) => setAt(copy, path, value) === null) ? copy : null
}

const SCHEMAS = { card: CardDoc, preset: PresetDoc, note: NoteDoc, lorebook: LorebookDoc } as const

/** Whether documents of this kind have a schema to be checked against. */
export const hasSchema = (kind: EntityKind): kind is keyof typeof SCHEMAS => Object.hasOwn(SCHEMAS, kind)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * The document as its kind's schema reads it, so what's stored is what the schema allows;
 * keys the schema doesn't know are dropped. Problems name their paths, at most 20.
 */
export const validateDoc = (
  kind: EntityKind,
  doc: unknown
):
  | { readonly ok: true; readonly doc: Doc }
  | { readonly ok: false; readonly problems: ReadonlyArray<string>; readonly paths: ReadonlyArray<FieldPath> } => {
  if (!hasSchema(kind)) return { ok: false, problems: [`A ${kind} can't be edited yet.`], paths: [] }
  const result = Schema.decodeUnknownResult(SCHEMAS[kind] as Schema.Codec<unknown, unknown>)(doc)
  if (Result.isSuccess(result))
    return {
      ok: true,
      doc: (kind === "preset" ? withMain(result.success as PresetDoc) : result.success) as Doc
    }
  const issues = formatIssues(result.failure.issue).issues.slice(0, 20)
  return {
    ok: false,
    problems: issues.map((issue) => `${(issue.path ?? []).map(String).join(".") || "the document"}: ${issue.message}`),
    paths: issues.map((issue) =>
      (issue.path ?? []).map((segment) => (typeof segment === "number" ? segment : String(segment)))
    )
  }
}

/**
 * Values the schema reads in an older shape and keeps in the current one, by kind and path: a
 * draft holding the older shape (saved before the change) isn't dropped by the rewrite.
 */
const OLDER_SHAPES: Partial<Record<EntityKind, ReadonlyArray<{ path: FieldPath; read: (value: unknown) => unknown }>>> =
  {
    note: [{ path: ["condition"], read: upgradedCondition }]
  }

/**
 * Drafts the schema would drop from the document, such as text at a key it doesn't know:
 * saving them would end the draft and keep nothing of it.
 */
export const droppedDrafts = (kind: EntityKind, applied: Doc, valid: Doc, drafts: ReadonlyArray<DraftContent>) =>
  drafts.filter(({ field }) => {
    const parsed = parseField(field)
    if (parsed === null) return false
    const older = OLDER_SHAPES[kind]?.find((shape) => canonicalJson(shape.path) === canonicalJson(parsed.path))
    const value = getAt(applied, parsed.path)
    return canonicalJson(older ? older.read(value) : value) !== canonicalJson(getAt(valid, parsed.path))
  })

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
 * Whether a preset or card keeps its regex approval through a change that isn't the user's own
 * typing (a merge, a restored revision): only if it had it, and the scripts are the ones
 * it had (DESIGN §11). Approval is gained only by approving.
 */
export const keepsRegexApproval = (ours: Doc, next: Doc) =>
  ours.regex_approved === true && canonicalJson(ours.regex) === canonicalJson(next.regex)

/**
 * The agent's permission to edit a note or a card module is given only by the user setting
 * it (DESIGN §4.1a): anything else (a restore, a merge, a resolved update) keeps it off where
 * the head has it off.
 */
export const withoutGrantedAgentEdits = (kind: EntityKind, ours: Doc, next: Doc): Doc => {
  if (kind === "note") {
    return next.agent_editable === true && ours.agent_editable !== true ? { ...next, agent_editable: false } : next
  }
  if (kind !== "card" || !Array.isArray(next.modules)) return next
  const allowed = new Set(
    (Array.isArray(ours.modules) ? ours.modules : []).flatMap((module: unknown) =>
      isObject(module) && module.agent_editable === true ? [module.id] : []
    )
  )
  return {
    ...next,
    modules: next.modules.map((module: unknown) =>
      isObject(module) && module.agent_editable === true && !allowed.has(module.id)
        ? { ...module, agent_editable: false }
        : module
    )
  }
}

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
  extensions: {}
})

/** Where a new note goes (DESIGN §4.1): the end of the tail, as the system. */
const NEW_NOTE_PLACEMENT = { mode: "section", section: "tail_end", role: "system" } as const

/**
 * A new note on a card, off in chats until switched on there; with `link`, a slot showing
 * that shared note.
 */
export const newCardNote = (card: EntityId, title: string, link?: EntityId): NoteDoc => ({
  schema_version: NOTE_SCHEMA_VERSION,
  title,
  content: "",
  placement: NEW_NOTE_PLACEMENT,
  owner: { card },
  exportable: true,
  agent_editable: false,
  ...(link ? { link } : {})
})

/** A new note of a chat's own; with `link`, a slot showing that shared note. */
export const newChatNote = (chat: ChatId, title: string, link?: EntityId): NoteDoc => ({
  schema_version: NOTE_SCHEMA_VERSION,
  title,
  content: "",
  placement: NEW_NOTE_PLACEMENT,
  owner: { chat },
  exportable: false,
  agent_editable: false,
  ...(link ? { link } : {})
})

/** A shared named note (DESIGN §4.1): a named text a note slot can link to, global for now. */
export const newSharedNote = (title: string, content: string): NoteDoc => ({
  schema_version: NOTE_SCHEMA_VERSION,
  title,
  content,
  placement: NEW_NOTE_PLACEMENT,
  owner: { shared: "global" },
  exportable: false,
  agent_editable: false
})
