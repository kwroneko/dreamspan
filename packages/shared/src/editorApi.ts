// The editor RPCs (ARCHITECTURE.md "Editing the library"; DESIGN §4, §6.2), merged into
// AppApi. Every text field edits through a draft on the server, with its own undo history;
// saving commits the drafts as one revision. Writes carry the row version the client saw.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, SlotId } from "./chat.ts"
import { BinItem } from "./bin.ts"
import { Draft, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { Doc, LibraryRef, MergeOutcome, MergePreview, RefId, Revision, RevisionId } from "./library.ts"

/** The document wouldn't be valid with these changes; nothing was saved. */
export class InvalidDocument extends Schema.TaggedError<InvalidDocument>()("InvalidDocument", {
  problems: Schema.Array(Schema.String)
}) {}

/** The change doesn't apply here (a chat override can't be forked, the update moved on). */
export class EditRefused extends Schema.TaggedError<EditRefused>()("EditRefused", {
  message: Schema.String
}) {}

/**
 * Fields whose drafts started from an older revision, changed since in the saved version
 * (another tab saved, or an update merged in). Nothing was saved: the user picks per field.
 */
export class EditConflict extends Schema.TaggedError<EditConflict>()("EditConflict", {
  fields: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      /** The value in the saved version; none if it's gone. */
      saved: Schema.optionalKey(Schema.Unknown),
      draft: Schema.Unknown
    })
  )
}) {}

/** A ref after a change, and what happened to the refs following it, transitively. */
export class SavedRef extends Schema.Class<SavedRef>("SavedRef")({
  ref: LibraryRef,
  followers: Schema.Array(Schema.Struct({ refId: RefId, outcome: MergeOutcome })),
  /**
   * Drafts in something that's gone since (a deleted prompt's text): not saved, and their text
   * is in the bin's recovered texts.
   */
  setAside: Schema.Array(Schema.String),
  /**
   * How many earlier texts of the saved drafts went to the bin's recovered texts: from
   * before a destructive change, or another tab's text a save went over.
   */
  recovered: Schema.Int
}) {}

/** Everything the editor opens with, read in one snapshot. */
export class EditorSnapshot extends Schema.Class<EditorSnapshot>("EditorSnapshot")({
  ref: LibraryRef,
  doc: Doc,
  /** Chats this ref's changes reach (ARCHITECTURE.md "Editing the library"). */
  usedByChats: Schema.Int,
  /** Every draft of this ref's fields, ended ones too: their row versions are needed to start again. */
  drafts: Schema.Array(Draft),
  /** The entity's upstream and variants, this one included. */
  variants: Schema.Array(LibraryRef)
}) {}

export class NoteEntry extends Schema.Class<NoteEntry>("NoteEntry")({ ref: LibraryRef, doc: Doc }) {}

/** A label as the library shows it: one line, trimmed, not empty. */
const Label = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isPattern(/^\P{Cc}*$/u))
const Subtitle = Schema.String.check(Schema.isMaxLength(200), Schema.isPattern(/^\P{Cc}*$/u))

const Errors = [NotFound, ServerError] as const
const Writes = [NotFound, StaleWrite, EditRefused, ServerError] as const

/** A chat note edits from the displayed position, on that branch. */
export const ChatNotePosition = Schema.Struct({ chatId: ChatId, slotId: Schema.NullOr(SlotId) })
export type ChatNotePosition = typeof ChatNotePosition.Type

const DraftField = { refId: RefId, field: Schema.String }

/**
 * Text typed into a field: the draft it was typed into (`draftId`, null before it had one),
 * as the client last had it, and the text now. Also what a closing page sends
 * (`drafts` in `POST /library/drafts`, with keepalive).
 */
export const EditorDraftSave = Schema.Struct({
  ...DraftField,
  draftId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  content: Schema.String,
  expectedRowVersion: Schema.NullOr(Schema.Int),
  expectedSession: Schema.optionalKey(Schema.Int),
  baseRevisionId: Schema.NullOr(RevisionId)
})

export class EditorApi extends RpcGroup.make(
  Rpc.make("OpenEditor", {
    payload: { refId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: EditorSnapshot,
    error: Schema.Union([...Errors])
  }),
  /** A card from scratch: an upstream with every field empty but its name. */
  Rpc.make("CreateCard", {
    payload: { label: Label, name: Schema.String },
    success: LibraryRef,
    error: Schema.Union([InvalidDocument, ServerError])
  }),
  // --- Drafts. `field` is a path in the document (editing.ts).
  /**
   * Null `expectedRowVersion` starts the draft. `baseRevisionId` is the revision the text
   * started from: given when a session starts, or to take the saved version as the new base.
   */
  Rpc.make("SaveEditorDraft", {
    payload: EditorDraftSave.fields,
    success: Draft,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("EditorDraftHistory", {
    payload: { ...DraftField, limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })) },
    success: Schema.Array(DraftState),
    error: Schema.Union([...Errors])
  }),
  /** Moves the draft back to an earlier state; the restore is itself undoable. */
  Rpc.make("RestoreEditorDraft", {
    payload: { ...DraftField, draftId: Schema.String, seq: Schema.Int, expectedRowVersion: Schema.Int },
    success: Draft,
    error: Schema.Union([...Writes])
  }),
  /** Ends a draft unsaved. Its text goes to the bin's recovered texts. */
  Rpc.make("DiscardEditorDraft", {
    payload: { ...DraftField, draftId: Schema.String, expectedRowVersion: Schema.Int },
    success: Draft,
    error: Schema.Union([...Writes])
  }),
  /** Saves the named drafts as one revision, and ends them. */
  Rpc.make("CommitEditorDrafts", {
    payload: {
      chatNote: Schema.optionalKey(ChatNotePosition),
      refId: RefId,
      expectedRowVersion: Schema.Int,
      /** Each draft by its field, its id and the row version the client saved it at. */
      fields: Schema.Array(
        Schema.Struct({ field: Schema.String, draftId: Schema.String, expectedRowVersion: Schema.Int })
      ),
      message: Schema.NullOr(Schema.String)
    },
    success: SavedRef,
    error: Schema.Union([...Writes, EditConflict, InvalidDocument])
  }),
  // --- Revisions.
  Rpc.make("ListRevisions", {
    payload: { refId: RefId, limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })) },
    success: Schema.Array(Revision),
    error: Schema.Union([...Errors])
  }),
  /** A revision of the ref's entity, to compare or restore. */
  Rpc.make("GetRevision", {
    payload: { refId: RefId, revisionId: RevisionId },
    success: Doc,
    error: Schema.Union([...Errors])
  }),
  /** A new revision with an earlier one's content: nothing in between is lost. */
  Rpc.make("RestoreRevision", {
    payload: { refId: RefId, revisionId: RevisionId, expectedRowVersion: Schema.Int },
    success: SavedRef,
    error: Schema.Union([...Writes])
  }),
  // --- Edit scope (DESIGN §4).
  /** A named variant following this ref, optionally taking this ref's unsaved drafts along. */
  Rpc.make("ForkVariant", {
    payload: { refId: RefId, label: Label, subtitle: Subtitle, moveDrafts: Schema.Boolean },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("RenameRef", {
    payload: { refId: RefId, label: Label, subtitle: Subtitle, expectedRowVersion: Schema.Int },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  /** The user allows (or stops) a preset's regex scripts, as ST asks once per preset (ARCHITECTURE.md §9). */
  Rpc.make("SetRegexApproval", {
    payload: { refId: RefId, approved: Schema.Boolean, expectedRowVersion: Schema.Int },
    success: SavedRef,
    error: Schema.Union([...Writes])
  }),
  // --- Updates from what the ref follows (§3.9).
  Rpc.make("PreviewUpdate", {
    payload: { refId: RefId },
    success: MergePreview,
    error: Schema.Union([...Errors, EditRefused])
  }),
  /** Merges in what the ref follows when that needs no help. */
  Rpc.make("ApplyUpdate", {
    payload: { refId: RefId },
    success: Schema.Struct({ outcome: MergeOutcome, saved: SavedRef }),
    error: Schema.Union([...Errors])
  }),
  /** Commits an update the user resolved by hand, against the preview's `theirsRevisionId`. */
  Rpc.make("ResolveUpdate", {
    payload: { refId: RefId, doc: Doc, theirsRevisionId: RevisionId, expectedRowVersion: Schema.Int },
    success: SavedRef,
    error: Schema.Union([...Writes, InvalidDocument])
  }),
  // --- A card's notes (DESIGN §4.1). Each is an entity of its own, edited like any ref.
  Rpc.make("ListCardNotes", {
    payload: { cardRefId: RefId },
    success: Schema.Array(NoteEntry),
    error: Schema.Union([...Errors])
  }),
  Rpc.make("CreateCardNote", {
    payload: { cardRefId: RefId, title: Schema.String },
    success: LibraryRef,
    error: Schema.Union([...Errors])
  }),
  /** A card's note or a chat's, to the bin like any delete. */
  Rpc.make("DeleteNote", { payload: { noteRefId: RefId }, success: BinItem, error: Schema.Union([...Errors]) })
) {}
