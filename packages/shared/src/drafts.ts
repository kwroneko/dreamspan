// Drafts with server-persisted undo history for every text field (DESIGN §6.2,
// DATA-MODEL §10). History is a list of reversible patches: from the current text you
// can step back to any earlier state, and a destructive change (Ctrl-A plus a stray key)
// always leaves the state before it restorable.
import { Schema } from "effect"

export const DraftTargetKind = Schema.Literals([
  "composer",
  "version_edit",
  "scratchpad",
  "entity_field",
  "summary_edit"
])

/** What a draft is for: the composer of a chat, the edit of a version, a field of a ref... */
export class DraftKey extends Schema.Class<DraftKey>("DraftKey")({
  targetKind: DraftTargetKind,
  targetId: Schema.String,
  /**
   * Composer: the slot the next message goes under (the branch's tip), or empty before
   * the first message. Entity fields: a JSON path into the document. Otherwise empty.
   */
  field: Schema.String
}) {}

/**
 * The composer belongs to a branch, not just a chat: each branch tip has its own, so
 * leaving a half-typed message and coming back, even months later, finds it where it
 * was, and another branch or chat shows its own composer. Anything appended at the tip
 * carries the composer forward to the new tip; sending commits it.
 */
export const composerKey = (chatId: string, tipSlotId: string | null) =>
  new DraftKey({ targetKind: "composer", targetId: chatId, field: tipSlotId ?? "" })

const DraftStatus = Schema.Literals(["active", "committed", "discarded"])

export class Draft extends Schema.Class<Draft>("Draft")({
  id: Schema.String,
  key: DraftKey,
  content: Schema.String,
  status: DraftStatus,
  /** What the draft was started from, for conflict detection on commit. */
  baseRevision: Schema.NullOr(Schema.String),
  rowVersion: Schema.Int,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  /**
   * Number of earlier states that can be restored. History is deleted on commit; text a
   * commit or discard would lose goes to the bin's recovered-text section.
   */
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
  kind: Schema.Literals(["initial", "edit", "restore"])
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
 * A change that throws away a lot of text. It always gets its own history entry, so the
 * text before it can be restored in one step. Only lengths matter, so history can be
 * scanned without rebuilding earlier texts.
 */
export const isDestructive = (patch: Patch, beforeLength: number) =>
  patch.removed.length > 200 || (beforeLength >= 20 && patch.removed.length > beforeLength / 2)

/** History tuning. Saves arrive debounced from the client, roughly once a second while typing. */
export const DraftHistoryPolicy = {
  /** A save within this long of the previous entry extends it... */
  coalesceGapMs: 5_000,
  /** ...unless the entry already spans this long. */
  coalesceSpanMs: 60_000,
  maxEntries: 1_000,
  /** Total removed + inserted characters kept across a draft's history. */
  maxHistoryChars: 1_000_000,
  maxContentChars: 1_000_000
} as const

/** Shortens text for a history list: the start and the end, around an ellipsis. */
export const excerpt = (text: string, max = 80) =>
  text.length <= max ? text : `${text.slice(0, max / 2 - 1)}…${text.slice(text.length - (max / 2 - 1))}`
