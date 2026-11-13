// Search and replace across the library (ARCHITECTURE §14.6 "Across the library"): the text of
// every card, lorebook, preset and note at once, as each one's editor shows it (its unsaved
// changes included), with a preview of every entry and field a replace would change and one
// undoable replace over the ones left ticked. An entry with unsaved changes is skipped. What a field is, and its label, are
// libraryText.ts's, which the editors' own Search and replace reads too.
import { Schema } from "effect"
import { EntityKind, RefId } from "./library.ts"

/** Storage kinds accepted on the wire; searchable kinds are contributed to libraryReplaceKinds. */
export const LibraryReplaceKind = EntityKind
export type LibraryReplaceKind = EntityKind

export class LibraryReplaceRejected extends Schema.TaggedError<LibraryReplaceRejected>()("LibraryReplaceRejected", {
  message: Schema.String
}) {}

/** What's looked for and what replaces it, with the editors' options. */
export const LibrarySearch = Schema.Struct({
  find: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  replace: Schema.String.check(Schema.isMaxLength(10000)),
  matchCase: Schema.Boolean,
  wholeWord: Schema.Boolean,
  regex: Schema.Boolean,
  preserveCase: Schema.Boolean,
  kinds: Schema.Array(LibraryReplaceKind).check(Schema.isMinLength(1), Schema.isMaxLength(32))
})
export type LibrarySearch = typeof LibrarySearch.Type

/**
 * What a replace says of an entry that has unsaved changes (an active draft, in this tab or
 * another): it leaves it as it is (owner, 2026-11-13: "skip and tell").
 */
export const LIBRARY_UNSAVED_REASON =
  "It has unsaved changes, so it was skipped. Open it to save or revert them, then find again."

/** Characters shown either side of a field's first match. */
export const AROUND = 48

/** A field's first match, with the text around it and what replaces it. */
export const FieldExcerpt = Schema.Struct({
  text: Schema.String,
  /** Where the match is in `text`. */
  at: Schema.Int,
  length: Schema.Int,
  replacement: Schema.String,
  /** Text was left out before or after it. */
  before: Schema.Boolean,
  after: Schema.Boolean
})
export type FieldExcerpt = typeof FieldExcerpt.Type

const LibraryFieldHit = Schema.Struct({
  /** The field as drafts name it (`textField` of its path, editing.ts). */
  field: Schema.String,
  label: Schema.String,
  count: Schema.Int,
  excerpt: FieldExcerpt
})

export const LibraryEntryHit = Schema.Struct({
  refId: RefId,
  kind: LibraryReplaceKind,
  label: Schema.String,
  subtitle: Schema.String,
  /** The entry as it was read: a replace refuses an entry changed since. */
  stamp: Schema.String,
  /** It has unsaved changes: its matches are listed, and a replace skips it. */
  unsaved: Schema.Boolean,
  /** Why it can't be replaced in now; null when it can. */
  blocked: Schema.NullOr(Schema.String),
  count: Schema.Int,
  fields: Schema.Array(LibraryFieldHit)
})
export type LibraryEntryHit = typeof LibraryEntryHit.Type

const LibraryKindCount = Schema.Struct({
  kind: LibraryReplaceKind,
  entries: Schema.Int,
  matches: Schema.Int
})

export const LibraryPreview = Schema.Struct({
  /** Entries with a match, in the library's kind order, then by name. */
  entries: Schema.Array(LibraryEntryHit),
  /** Per kind looked through: entries with a match and matches. */
  counts: Schema.Array(LibraryKindCount),
  /** Entries looked through. */
  searched: Schema.Int
})
export type LibraryPreview = typeof LibraryPreview.Type

/** An entry left ticked, with its fields left ticked. */
export const LibraryChoice = Schema.Struct({
  refId: RefId,
  stamp: Schema.String,
  /** This browser still has text that has not reached a server draft. */
  unsaved: Schema.optionalKey(Schema.Boolean),
  fields: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20000))
})
export type LibraryChoice = typeof LibraryChoice.Type

/** An entry a replace or its undo left as it was, and why. */
export const LibrarySkipped = Schema.Struct({ refId: RefId, label: Schema.String, reason: Schema.String })
export type LibrarySkipped = typeof LibrarySkipped.Type

export const LibraryReplaceResult = Schema.Struct({
  /** The replace, for its undo; null when nothing was changed. */
  editId: Schema.NullOr(Schema.String),
  entries: Schema.Int,
  matches: Schema.Int,
  skipped: Schema.Array(LibrarySkipped),
  /** Scripts changed by this user replace whose existing approval was retained. */
  approvedScripts: Schema.Array(Schema.Struct({ refId: RefId, label: Schema.String, name: Schema.String }))
})
export type LibraryReplaceResult = typeof LibraryReplaceResult.Type

/** A replace done across the library, for its undo. */
export const LibraryEdit = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  createdAt: Schema.Number,
  entries: Schema.Int,
  matches: Schema.Int,
  /** Entries already undone. */
  undone: Schema.Int
})
export type LibraryEdit = typeof LibraryEdit.Type

export const LibraryUndoResult = Schema.Struct({ undone: Schema.Int, kept: Schema.Array(LibrarySkipped) })

/** Replaces listed for undo at most, newest first. */
export const LIBRARY_EDITS_LISTED = 10

/** The replace's name, on its revisions and in the list of replaces. */
export const libraryEditTitle = (search: Pick<LibrarySearch, "find" | "replace">) => {
  const short = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text)
  return `Replaced “${short(search.find)}” with “${short(search.replace)}” across the library`
}
