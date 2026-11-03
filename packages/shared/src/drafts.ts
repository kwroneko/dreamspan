// Drafts with server-persisted undo history for every text field (DESIGN §6.2,
// DATA-MODEL §10). History is a list of reversible patches: from the current text you
// can step back to any earlier state, and a destructive change (Ctrl-A plus a stray key)
// always leaves the state before it restorable.
import { Schema } from "effect"
import { beforeDeletion, deletionMap } from "./draftDeletions.ts"
import { MessageImages } from "./chat.ts"

/** Legacy strings remain valid; anonymous input clears need evidence independent of final text counts. */
export const EditingOrigin = Schema.Union([
  Schema.String,
  Schema.Struct({ content: Schema.String, clearedArrays: Schema.Array(Schema.Array(Schema.String)) })
])
export type EditingOrigin = typeof EditingOrigin.Type

export const DraftTargetKind = Schema.Literals([
  "composer",
  "version_edit",
  "scratchpad",
  "entity_field",
  "user_field",
  "summary_edit",
  "queue_edit",
  "insert"
])

/** What a draft is for: the composer of a chat, the edit of a version, a field of a ref... */
export class DraftKey extends Schema.Class<DraftKey>("DraftKey")({
  targetKind: DraftTargetKind,
  targetId: Schema.String,
  /**
   * Composer and snippet: the fork it's typed in (the recovered text of one whose fork isn't known has
   * it empty). Entity fields: a JSON path into the document. Insert: the fork and the anchor
   * (`insertDraftKey`). Otherwise empty.
   */
  field: Schema.String
}) {}

/**
 * A library field's draft target: its ref, or for a chat's own note the ref and the branch it's
 * edited in (`scope`: the fork), so
 * each branch keeps its own unsaved text (owner, 2026-11-01: the note is tied to its branch).
 */
export const entityDraftTarget = (refId: string, scope?: string | null) =>
  scope === undefined || scope === null || scope === "" ? refId : `${refId}/${scope}`

/** The ref a library field's draft target names, and its branch scope (null: none). */
export const parseDraftTarget = (targetId: string) => {
  const at = targetId.indexOf("/")
  return at < 0 ? { refId: targetId, fork: null } : { refId: targetId.slice(0, at), fork: targetId.slice(at + 1) }
}

/**
 * The composer belongs to a fork, not just a chat: each fork has its own, so leaving a
 * half-typed message and coming back, even months later, finds it where it was, and another
 * fork or chat shows its own composer, even one at the same message. It stays with its fork
 * as messages are appended; sending commits it.
 */
export const composerKey = (chatId: string, forkId: string | null) =>
  new DraftKey({ targetKind: "composer", targetId: chatId, field: forkId ?? "" })

/**
 * The text of a message being inserted (spec/MESSAGE-INSERT.md §3.1): one per chat, fork and
 * anchor (the message it goes below; empty above the first message), so leaving the editor
 * and coming back to the same place finds it. Inserting the message commits it.
 */
export const insertDraftKey = (chatId: string, forkId: string, anchor: string | null) =>
  new DraftKey({ targetKind: "insert", targetId: chatId, field: `${forkId}:${anchor ?? ""}` })

const DraftStatus = Schema.Literals(["active", "committed", "discarded"])

/** Text this write displaced, as recorded by the writer; reads return null. */
export class DraftDisplacement extends Schema.Class<DraftDisplacement>("DraftDisplacement")({
  at: Schema.Number,
  content: Schema.String,
  images: Schema.optionalKey(MessageImages)
}) {}

/** A deletion the editor observed; this never replaces the base its text was typed on. */
export const ObservedDeletion = Schema.Struct({ draftId: Schema.String, rowVersion: Schema.Int })
export type ObservedDeletion = typeof ObservedDeletion.Type

export const FieldDeletion = Schema.Struct({
  ...ObservedDeletion.fields,
  value: Schema.optionalKey(Schema.Unknown),
  missing: Schema.optionalKey(Schema.Boolean)
})
export type FieldDeletion = typeof FieldDeletion.Type

export class Draft extends Schema.Class<Draft>("Draft")({
  id: Schema.String,
  key: DraftKey,
  content: Schema.String,
  /** Message editor attachments; absent means the source version's set. */
  images: Schema.optionalKey(MessageImages),
  status: DraftStatus,
  /** What the draft was started from, for conflict detection on commit. */
  baseRevision: Schema.NullOr(Schema.String),
  rowVersion: Schema.Int,
  /** Last deliberate emptying/discard, retained across later text. Recovery compares server versions, never clocks. */
  clearedVersion: Schema.optionalKey(Schema.Int),
  /** Per-input barriers, including a moved history's original logical target. Empty key means the whole field. */
  deletions: Schema.optionalKey(Schema.Record(Schema.String, FieldDeletion)),
  /**
   * The drafting session, counted up each time one ends (committed or discarded). Text
   * typed in a session that has ended is never taken as the start of the next one.
   */
  session: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  /**
   * Number of earlier states that can be restored. History is deleted on commit; text a
   * commit or discard would lose goes to the bin's recovered-text section.
   */
  /** Texts this write sent to recovered texts; reads return zero. */
  recovered: Schema.Int,
  displaced: Schema.NullOr(DraftDisplacement),
  historyLength: Schema.Int
}) {}

/** One restorable state in a draft's history. Seq 0 is the text the draft started with. */
export class DraftState extends Schema.Class<DraftState>("DraftState")({
  seq: Schema.Int,
  at: Schema.Number,
  length: Schema.Int,
  /** What changed to reach this state, shortened for a list. */
  removed: Schema.String,
  inserted: Schema.String,
  /**
   * `revision`: the field took a revision's text it wasn't typed on (a revision restored, an
   * update merged in) before the next edit, so the edit history goes through what was shown.
   */
  kind: Schema.Literals(["initial", "edit", "restore", "revision"])
}) {}

/** A single replacement: at `start`, `removed` was replaced by `inserted`. Invertible. */
export interface Patch {
  readonly start: number
  readonly removed: string
  readonly inserted: string
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * The single replacement that turns `before` into `after`: common prefix and suffix
 * trimmed, never splitting a surrogate pair (so stored text stays valid UTF-8).
 */
export const diffPatch = (before: string, after: string): Patch => {
  const max = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++
  if (prefix > 0 && prefix < before.length && isLowSurrogate(before.charCodeAt(prefix))) prefix--
  let suffix = 0
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--
  return {
    start: prefix,
    removed: before.slice(prefix, before.length - suffix),
    inserted: after.slice(prefix, after.length - suffix)
  }
}

export const applyPatch = (text: string, patch: Patch): string =>
  text.slice(0, patch.start) + patch.inserted + text.slice(patch.start + patch.removed.length)

export const invertPatch = (patch: Patch): Patch => ({
  start: patch.start,
  removed: patch.inserted,
  inserted: patch.removed
})

export const isEmptyPatch = (patch: Patch) => patch.removed.length === 0 && patch.inserted.length === 0

/**
 * What a patch throws away. Line endings rewritten don't count: a text box turns an imported
 * file's CRLF into LF at the first key typed, which replaces nearly the whole text.
 */
const lost = (patch: Patch) =>
  patch.removed.includes("\r")
    ? diffPatch(patch.removed.replaceAll("\r\n", "\n"), patch.inserted.replaceAll("\r\n", "\n")).removed.length
    : patch.removed.length

/**
 * A change that throws away a lot of text. It always gets its own history entry, so the
 * text before it can be restored in one step. Only the patch matters, so history can be
 * scanned without rebuilding earlier texts.
 */
export const isDestructive = (patch: Patch, beforeLength: number) => {
  const removed = lost(patch)
  return removed > 200 || (beforeLength >= 20 && removed > beforeLength / 2)
}

/** History tuning. Saves arrive debounced from the client, roughly once a second while typing. */
export const DraftHistoryPolicy = {
  /** A save within this long of the previous entry extends it... */
  coalesceGapMs: 5_000,
  /** ...unless the entry already spans this long. */
  coalesceSpanMs: 60_000,
  maxEntries: 1_000,
  /** Total removed + inserted characters kept across a draft's history. */
  maxHistoryChars: 1_000_000,
  maxContentChars: 1_000_000,
  /**
   * A library field's edit history (`entity_field`, owner 2026-11-01) outlives revisions and
   * keeps whichever is more: the last `fieldStates` states or the last `fieldDays` days.
   * The two limits above don't apply to it.
   */
  fieldStates: 200,
  fieldDays: 30
} as const

/** Shortens text for a history list: the start and the end, around an ellipsis. */
export const excerpt = (text: string, max = 80) =>
  text.length <= max ? text : `${text.slice(0, max / 2 - 1)}…${text.slice(text.length - (max / 2 - 1))}`

/** Restore from history, or an explicitly picked browser-conflict text retained by the client. */
export const DraftRestore = {
  seq: Schema.Int,
  expectedRowVersion: Schema.Int,
  content: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DraftHistoryPolicy.maxContentChars))),
  images: Schema.optionalKey(MessageImages)
}

/** A browser copy typed before the latest deletion must never reopen the field. */
export const deletedSince = (
  draft: Draft | null,
  base: {
    readonly draftId: string | null
    readonly expectedRowVersion: number | null
    readonly observedDeletion?: ObservedDeletion
  } | null
): boolean => {
  if (draft === null) return false
  const deletion = deletionMap(draft)[""]
  return deletion !== undefined && beforeDeletion(draft.id, deletion, base)
}

export const observeDeletion = (draft: Draft | null): ObservedDeletion | null =>
  draft !== null && Object.keys(deletionMap(draft)).length > 0
    ? { draftId: draft.id, rowVersion: draft.rowVersion }
    : null
