import { ArchiveCriteria, ArchiveCandidate, CardArchiveReceipt } from "./cardArchive.ts"
import { ForkMergePreview, MergeSelection, MergeStatus, LibraryGenealogy } from "./forkMerge.ts"
// The editor RPCs (ARCHITECTURE.md "Editing the library"; DESIGN §4, §6.2), merged into
// AppApi. Every text field edits through a draft on the server, with its own undo history;
// saving commits the drafts as one revision. Writes carry the row version the client saw.
import { AssetChange, CardGallery } from "./gallery.ts"
import { AvatarCrop } from "./media.ts"
import { UserId } from "./domain.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, ForkId, SlotId } from "./chat.ts"
import { BinItem } from "./bin.ts"
import { EditingOrigin, ObservedDeletion, Draft, DraftRestore, DraftState } from "./drafts.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { CardFamily, Doc, LibraryRef, MergeOutcome, MergePreview, RefId, Revision, RevisionId } from "./library.ts"

/** The document wouldn't be valid with these changes; nothing was saved. */
export class InvalidDocument extends Schema.TaggedError<InvalidDocument>()("InvalidDocument", {
  problems: Schema.Array(Schema.String)
}) {}

/** The change doesn't apply here (a card forks with its names, the update moved on). */
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
  recovered: Schema.Int,
  /** The fields those texts came from. */
  recoveredFields: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

/** Everything the editor opens with, read in one snapshot. */
export class EditorSnapshot extends Schema.Class<EditorSnapshot>("EditorSnapshot")({
  ref: LibraryRef,
  doc: Doc,
  /** Chats this ref's changes reach (ARCHITECTURE.md "Editing the library"). */
  usedByChats: Schema.Int,
  /** Every draft of this ref's fields, ended ones too: their row versions are needed to start again. */
  drafts: Schema.Array(Draft),
  /** The head's number along its first-parent line, from 1: "changed since revision N". */
  revisionNumber: Schema.Int,
  /** Non-card upstream and variants, this one included; empty for cards. */
  variants: Schema.Array(LibraryRef),
  /**
   * A chat's own note opened at a position: the branch its drafts belong to (sent back as each
   * draft call's `scope`), and what its editor says about where a change applies.
   */
  chatNote: Schema.optionalKey(
    Schema.Struct({
      scope: Schema.String,
      /** Another branch of the chat has a version of its own (another revision, or unsaved text). */
      otherBranches: Schema.Boolean
    })
  )
}) {}

export class NoteEntry extends Schema.Class<NoteEntry>("NoteEntry")({
  ref: LibraryRef,
  doc: Doc,
  /**
   * The note as chats send it: its live text (its active drafts on `doc`, §14.2a), with a
   * linked slot's `content` its shared note's, live too. Absent when it sends nothing: a slot
   * linked to a shared note in the bin, or a note whose content isn't text.
   */
  sent: Schema.optionalKey(Doc)
}) {}

/** A shared named note (DESIGN §4.1), as the picker lists it: how many slots link to it. */
export class SharedNote extends Schema.Class<SharedNote>("SharedNote")({
  ref: LibraryRef,
  title: Schema.String,
  /** The start of its text, on one line. */
  excerpt: Schema.String,
  /** The note slots (cards' and chats' notes) whose library head links to it. */
  usedBy: Schema.Int
}) {}

/** A label as the library shows it: one line, trimmed, not empty. */
const Label = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isPattern(/^\P{Cc}*$/u))
const Subtitle = Schema.String.check(Schema.isMaxLength(200), Schema.isPattern(/^\P{Cc}*$/u))

const Errors = [NotFound, ServerError] as const
const Writes = [NotFound, StaleWrite, EditRefused, ServerError] as const

/** A chat note edits from the displayed position, on that branch. */
export const ChatNotePosition = Schema.Struct({
  chatId: ChatId,
  forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
  slotId: Schema.NullOr(SlotId)
})
export type ChatNotePosition = typeof ChatNotePosition.Type

/** A chat's own note's branch, from its `EditorSnapshot.chatNote.scope`: its drafts are that branch's. */
const DraftScope = Schema.String.check(Schema.isMaxLength(200), Schema.isPattern(/^[^/]+$/))

const DraftField = { refId: RefId, field: Schema.String, scope: Schema.optionalKey(DraftScope) }

/**
 * Text typed into a field: the draft it was typed into (`draftId`, null before it had one),
 * as the client last had it, and the text now. Also what a closing page sends
 * (`drafts` in `POST /library/drafts`, with keepalive).
 */
export const EditorDraftSave = Schema.Struct({
  ...DraftField,
  draftId: Schema.NullOr(Schema.String),
  content: Schema.String,
  expectedRowVersion: Schema.NullOr(Schema.Int),
  expectedSession: Schema.NullOr(Schema.Int),
  baseRevisionId: Schema.NullOr(RevisionId)
})

/** Non-secret authored settings and pre-creation text; keys are private to the authenticated user. */
export const UserDraftSave = Schema.Struct({
  ownerId: UserId,
  targetId: Schema.String,
  field: Schema.String,
  observedDeletion: Schema.optionalKey(ObservedDeletion),
  draftId: Schema.NullOr(Schema.String),
  content: Schema.String,
  /** Saved form values establishing its first state, before the actual typed edit. */
  seed: Schema.optionalKey(Schema.Boolean),
  /** Text actually edited, retaining evidence of local clears until acknowledgement. */
  editingFrom: Schema.optionalKey(EditingOrigin),
  expectedRowVersion: Schema.NullOr(Schema.Int),
  expectedSession: Schema.NullOr(Schema.Int)
})

export class EditorApi extends RpcGroup.make(
  Rpc.make("GetUserDraft", {
    payload: { ownerId: UserId, targetId: Schema.String, field: Schema.String },
    success: Schema.NullOr(Draft),
    error: Schema.Union([...Errors])
  }),
  Rpc.make("SaveUserDraft", { payload: UserDraftSave.fields, success: Draft, error: Schema.Union([...Writes]) }),
  Rpc.make("UserDraftHistory", {
    payload: { ownerId: UserId, targetId: Schema.String, field: Schema.String },
    success: Schema.Array(DraftState),
    error: Schema.Union([...Errors])
  }),
  Rpc.make("RestoreUserDraft", {
    payload: {
      ownerId: UserId,
      targetId: Schema.String,
      field: Schema.String,
      draftId: Schema.String,
      ...DraftRestore
    },
    success: Draft,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("EndUserDraft", {
    payload: {
      ownerId: UserId,
      targetId: Schema.String,
      field: Schema.String,
      draftId: Schema.String,
      expectedRowVersion: Schema.Int,
      outcome: Schema.Literals(["committed", "discarded"])
    },
    success: Draft,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("OpenEditor", {
    payload: { refId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: EditorSnapshot,
    error: Schema.Union([...Errors])
  }),
  /** An ordered prompt preset using the built-in document and safe override defaults. */
  Rpc.make("CreatePreset", {
    payload: { label: Label },
    success: LibraryRef,
    error: Schema.Union([InvalidDocument, ServerError])
  }),
  /** An empty, named library lorebook. */
  Rpc.make("CreateLorebook", {
    payload: { label: Label },
    success: LibraryRef,
    error: Schema.Union([InvalidDocument, ServerError])
  }),
  /** A card from scratch: an upstream with every field empty but its name. */
  Rpc.make("CreateCard", {
    payload: {
      label: Label,
      name: Schema.String,
      nickname: Schema.optionalKey(Schema.String),
      version: Schema.optionalKey(Schema.String),
      description: Schema.optionalKey(Schema.String),
      persona: Schema.optionalKey(Schema.Boolean)
    },
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
  /** A field's edit history, newest first; `before` pages on to the states older than that seq. */
  Rpc.make("EditorDraftHistory", {
    payload: {
      ...DraftField,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
      before: Schema.optionalKey(Schema.Int)
    },
    success: Schema.Array(DraftState),
    error: Schema.Union([...Errors])
  }),
  /** One state's whole text, for the edit history to show. */
  Rpc.make("EditorDraftState", {
    payload: { ...DraftField, seq: Schema.Int },
    success: Schema.String,
    error: Schema.Union([...Errors])
  }),
  /** Moves the draft back to an earlier state; the restore is itself undoable. */
  Rpc.make("RestoreEditorDraft", {
    payload: { ...DraftField, draftId: Schema.String, ...DraftRestore },
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
    payload: {
      refId: RefId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.optionalKey(RevisionId),
      /** A chat's own note: its line as the branch at this position has it, each saying where it took effect. */
      chatNote: Schema.optionalKey(ChatNotePosition)
    },
    success: Schema.Array(Revision),
    error: Schema.Union([...Errors])
  }),
  /** A revision of the ref's entity, to compare or restore. */
  Rpc.make("GetRevision", {
    payload: { refId: RefId, revisionId: RevisionId },
    success: Doc,
    error: Schema.Union([...Errors])
  }),
  /**
   * Every field changed since the last revision back to it, each as a new state of its edit
   * history (the text there now stays one state back); no revision is written.
   */
  Rpc.make("RevertEditorDrafts", {
    payload: { refId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: Schema.Struct({ reverted: Schema.Int }),
    error: Schema.Union([...Errors])
  }),
  /** A revision's message, a label: added, changed or (empty) removed at any time. */
  Rpc.make("SetRevisionMessage", {
    payload: {
      refId: RefId,
      revisionId: RevisionId,
      message: Schema.String.check(Schema.isMaxLength(500), Schema.isPattern(/^\P{Cc}*$/u))
    },
    success: Schema.Void,
    error: Schema.Union([...Errors])
  }),
  /** A new revision with an earlier one's content: nothing in between is lost. */
  Rpc.make("RestoreRevision", {
    payload: {
      refId: RefId,
      revisionId: RevisionId,
      expectedRowVersion: Schema.Int,
      /** A chat's own note: restored on this branch, from this position on, as its Save would. */
      chatNote: Schema.optionalKey(ChatNotePosition)
    },
    success: SavedRef,
    error: Schema.Union([...Writes])
  }),
  // --- Edit scope (DESIGN §4).
  /**
   * A fork of this preset, lorebook or note: an entry of its own, which takes the original's later
   * changes only by an explicit merge (spec/LIBRARY-FORKS.md), optionally taking its unsaved drafts along.
   */
  Rpc.make("ForkVariant", {
    payload: { refId: RefId, label: Label, subtitle: Subtitle, moveDrafts: Schema.Boolean },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  // --- Card forks (spec/CARD-FORKS-DELTA.md §2): each fork is a card of its own.
  /**
   * A new card from this card ref's head, with the three names given (display name, in-character
   * name, version), its tags and notes copied, taking the unsaved text of the ref (but its
   * names) and of its notes, the original going back to its last revision (owner, 2026-11-02). `EditRefused` for a display name and version another card has.
   */
  Rpc.make("ForkCard", {
    payload: {
      refId: RefId,
      name: Schema.String.check(Schema.isMinLength(1)),
      nickname: Schema.String,
      characterVersion: Schema.String
    },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  /**
   * The caller's cards that have a fork family, each with its own forks' count: what a card's
   * fork badge shows, in one read for a whole grid (CardFamily is the tree, read when opened).
   */
  Rpc.make("CardFamilyIndex", {
    success: Schema.Array(Schema.Struct({ entityId: EntityId, forks: Schema.Int })),
    error: Schema.Union([...Errors])
  }),
  /** Every card connected to this one by forking: the same tree from any member. */
  Rpc.make("CardFamily", {
    payload: { entityId: EntityId },
    success: CardFamily,
    error: Schema.Union([...Errors])
  }),
  /**
   * "Mark as a fork of…" another card (an ST duplicate), or with null "Unlink". Neither card's
   * content changes. `EditRefused` for itself or a card already forked from this one.
   */
  Rpc.make("SetCardParent", {
    payload: { entityId: EntityId, parentEntityId: Schema.NullOr(EntityId) },
    success: CardFamily,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("RenameRef", {
    payload: { refId: RefId, label: Label, subtitle: Subtitle, expectedRowVersion: Schema.Int },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  /**
   * Archives a library entry, or takes it out of the archive: archived ones are left out of the
   * lists (an Archived view shows them), nothing is deleted, and one in use stays in use.
   * `EditRefused` for a chat's own copy.
   */
  Rpc.make("SetRefArchived", {
    payload: { refId: RefId, archived: Schema.Boolean },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  /** The user allows (or stops) a preset's regex scripts, as ST asks once per preset (ARCHITECTURE.md §9). */
  Rpc.make("SetRegexApproval", {
    payload: { refId: RefId, approved: Schema.Boolean, expectedRowVersion: Schema.Int },
    success: SavedRef,
    error: Schema.Union([...Writes])
  }),
  /**
   * The card's Picture and Portrait cuts (ARCHITECTURE.md §14.5c),
   * chosen again without a new image; null: back to the default. A new image's goes with
   * `POST /library/avatar`.
   */
  Rpc.make("SetCardAvatarCrop", {
    payload: { refId: RefId, crop: Schema.NullOr(AvatarCrop), expectedRowVersion: Schema.Int },
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
    error: Schema.Union([...Writes])
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
  /** A new note on the card, off in chats; with `link`, a slot showing that shared note. */
  Rpc.make("CreateCardNote", {
    payload: {
      chatNote: Schema.optionalKey(ChatNotePosition),
      cardRefId: RefId,
      title: Schema.String,
      link: Schema.optionalKey(EntityId)
    },
    success: LibraryRef,
    error: Schema.Union([...Errors])
  }),
  // --- Shared named notes (DESIGN §4.1): note entities owned by no card or chat.
  /**
   * The shared notes not in the bin, by title (`query` filters it), or just the one `refId`
   * or `entityId` (a slot's `link`) names.
   */
  Rpc.make("ListSharedNotes", {
    payload: {
      chatNote: Schema.optionalKey(ChatNotePosition),
      query: Schema.optionalKey(Schema.String),
      refId: Schema.optionalKey(RefId),
      entityId: Schema.optionalKey(EntityId)
    },
    success: Schema.Array(SharedNote),
    error: Schema.Union([...Errors])
  }),
  /**
   * A new shared note. With `fromNoteRefId`, made from that slot's text and title, and the
   * slot linked to it in the same transaction: a chat's note at `chatNote`, on that branch.
   */
  Rpc.make("CreateSharedNote", {
    payload: {
      title: Schema.String,
      content: Schema.String,
      fromNoteRefId: Schema.optionalKey(RefId),
      chatNote: Schema.optionalKey(ChatNotePosition)
    },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  /**
   * Turns a linked slot into its own copy: the shared note's text (its last revision, even
   * in the bin) as the slot's content, and no link. A chat's note at `chatNote`, on that branch.
   */
  Rpc.make("UnlinkNote", {
    payload: { noteRefId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: LibraryRef,
    error: Schema.Union([...Writes])
  }),
  /** A card's note or a chat's, to the bin like any delete. */
  Rpc.make("DeleteNote", { payload: { noteRefId: RefId }, success: BinItem, error: Schema.Union([...Errors]) })
) {}

/**
 * Explicit merges into a fork from its parent or import line, and the
 * family tree (DESIGN §4). A group of its own, merged into AppApi with its own handler
 * layer: one handler layer for every RPC exceeds TypeScript's instantiation depth (TS2589).
 */
export class ForkMergeApi extends RpcGroup.make(
  Rpc.make("ForkMergeStatus", {
    payload: { refId: RefId },
    success: MergeStatus,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("PreviewForkMerge", {
    payload: { refId: RefId, theirsRevisionId: Schema.optionalKey(RevisionId) },
    success: ForkMergePreview,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("LibraryGenealogy", {
    payload: { refId: RefId },
    success: LibraryGenealogy,
    error: Schema.Union([...Writes])
  }),
  Rpc.make("CommitForkMerge", {
    payload: {
      refId: RefId,
      theirsRevisionId: RevisionId,
      baseRevisionId: Schema.NullOr(RevisionId),
      expectedRowVersion: Schema.Int,
      selection: MergeSelection,
      message: Schema.NullOr(Schema.String)
    },
    success: SavedRef,
    error: Schema.Union([...Writes, InvalidDocument])
  }),
  Rpc.make("UndoForkMerge", {
    payload: { refId: RefId, mergeRevisionId: RevisionId, expectedRowVersion: Schema.Int },
    success: SavedRef,
    error: Schema.Union([...Writes])
  })
) {}

/** Card gallery operations, served separately to bound RPC handler inference. */
export class GalleryApi extends RpcGroup.make(
  Rpc.make("GetCardGallery", { payload: { refId: RefId }, success: CardGallery, error: Schema.Union([...Errors]) }),
  Rpc.make("ChangeCardAsset", {
    payload: { refId: RefId, uri: Schema.String, change: AssetChange, expectedRowVersion: Schema.Int },
    success: SavedRef,
    error: Schema.Union([...Writes])
  })
) {}

export class CardArchiveApi extends RpcGroup.make(
  Rpc.make("ListArchiveCandidates", {
    payload: { criteria: ArchiveCriteria },
    success: Schema.Array(ArchiveCandidate),
    error: ServerError
  }),
  Rpc.make("ArchiveUnusedCards", {
    payload: { criteria: ArchiveCriteria, entityIds: Schema.Array(EntityId) },
    success: CardArchiveReceipt,
    error: ServerError
  }),
  Rpc.make("UndoCardArchive", { payload: CardArchiveReceipt.fields, success: Schema.Int, error: ServerError })
) {}
