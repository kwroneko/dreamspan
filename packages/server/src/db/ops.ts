// Storage operations, executed inside the database worker threads (ARCHITECTURE.md §3).
// Each write operation runs as one synchronous transaction inside the writer worker,
// so a transaction can never span an await or a network call.
//
// Every operation on owned data takes the acting user and only touches rows that user
// owns (DATA-MODEL §1, principle 6). Rows owned by someone else are reported as
// NotFound, so their existence doesn't leak.
import { Chat, ChatId, ChatKind, EntityId, NewVersion, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import { User, UserId } from "@rp/shared/domain.ts"
import { Draft, DraftKey, DraftState } from "@rp/shared/drafts.ts"
import {
  Doc,
  EntityKind,
  LibraryRef,
  MergeOutcome,
  MergePreview,
  RefId,
  Revision,
  RevisionId
} from "@rp/shared/library.ts"
import { StateEventData } from "@rp/shared/state.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const StorageErrorReason = Schema.Literals(["busy", "constraint", "corrupt", "other"])

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  reason: StorageErrorReason,
  operation: Schema.String,
  message: Schema.String
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String
}) {}

/** Optimistic concurrency: the row moved on since the caller read it (DATA-MODEL §10). */
export class StaleWrite extends Schema.TaggedError<StaleWrite>()("StaleWrite", {
  entity: Schema.String,
  id: Schema.String,
  expected: Schema.Int,
  actual: Schema.Int
}) {}

/** The largest path window one GetPath returns. */
export const MAX_PATH_WINDOW = 1000

/** The operation doesn't apply to this kind of ref (e.g. forking a chat override). */
export class RefOperationRefused extends Schema.TaggedError<RefOperationRefused>()("RefOperationRefused", {
  refId: Schema.String,
  reason: Schema.String
}) {}

export class FollowerMerge extends Schema.Class<FollowerMerge>("FollowerMerge")({
  refId: RefId,
  outcome: MergeOutcome
}) {}

/** A ref after a change, and what happened to every ref that follows it, transitively. */
export class RefChange extends Schema.Class<RefChange>("RefChange")({
  ref: LibraryRef,
  followers: Schema.Array(FollowerMerge)
}) {}

export const StateEventOrigin = Schema.Literals(["user", "rollout", "changeset", "import"])

export class FoldableStateEvent extends Schema.Class<FoldableStateEvent>("FoldableStateEvent")({
  scope: Schema.NullOr(Schema.String),
  data: StateEventData
}) {}

export class DraftTooLarge extends Schema.TaggedError<DraftTooLarge>()("DraftTooLarge", {
  length: Schema.Int,
  max: Schema.Int
}) {}

/**
 * Marks the draft a write came from as committed, in the same transaction, so a reload
 * never shows text that was already sent. If the draft moved on since (another tab kept
 * typing), it stays active: it holds newer text than what was committed.
 */
export const CommitDraft = Schema.NullOr(Schema.Struct({ key: DraftKey, expectedRowVersion: Schema.Int }))

export class AppendResult extends Schema.Class<AppendResult>("AppendResult")({
  slotId: SlotId,
  version: Version,
  chat: Chat,
  /** The committed draft, or the draft left active because it moved on; null if none was given. */
  draft: Schema.NullOr(Draft)
}) {}

export class WriteOps extends RpcGroup.make(
  /** Answers once the writer has opened the database and run migrations. */
  Rpc.make("Ready"),
  Rpc.make("EnsureUser", {
    payload: { handle: Schema.String, displayName: Schema.String },
    success: User,
    error: StorageError
  }),
  /**
   * Saves a draft (debounced by the client while the user types). The first save creates
   * it, checking the target belongs to the user; later saves pass the row version they
   * last saw, so a stale tab can't overwrite newer text. Every change is kept as an undo
   * history entry (DESIGN §6.2).
   */
  Rpc.make("SaveDraft", {
    payload: {
      userId: UserId,
      key: DraftKey,
      content: Schema.String,
      /** Null to create the draft. */
      expectedRowVersion: Schema.NullOr(Schema.Int),
      baseRevision: Schema.NullOr(Schema.String)
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, DraftTooLarge, StorageError])
  }),
  /**
   * Starting a branch takes the composer along: copies the composer text at one tip to
   * another, unless the other already has text of its own. Switching between existing
   * branches doesn't copy (owner, 2026-10-10).
   */
  Rpc.make("CopyComposer", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      fromTipSlotId: Schema.NullOr(SlotId),
      toTipSlotId: Schema.NullOr(SlotId)
    },
    success: Schema.NullOr(Draft),
    error: Schema.Union([NotFound, StaleWrite, DraftTooLarge, StorageError])
  }),
  /** Restores an earlier state from the draft's history. The restore is itself undoable. */
  Rpc.make("RestoreDraftState", {
    payload: { userId: UserId, key: DraftKey, seq: Schema.Int, expectedRowVersion: Schema.Int },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /** Marks a draft committed or discarded. Its text and history are kept. */
  Rpc.make("ClearDraft", {
    payload: {
      userId: UserId,
      key: DraftKey,
      outcome: Schema.Literals(["committed", "discarded"]),
      expectedRowVersion: Schema.Int
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /** A new library entity with its first revision and its base (upstream) ref. */
  Rpc.make("CreateEntity", {
    payload: {
      userId: UserId,
      kind: EntityKind,
      label: Schema.String,
      subtitle: Schema.String,
      doc: Doc,
      schemaVersion: Schema.Int,
      origin: Schema.Literals(["user", "import"]),
      sourcePath: Schema.NullOr(Schema.String)
    },
    success: Schema.Struct({ entityId: EntityId, ref: LibraryRef }),
    error: StorageError
  }),
  /**
   * Commits an edit to a ref: a new revision on top of its head (DATA-MODEL §3.2). Refs
   * that follow it, transitively, merge the change in; their outcomes are returned.
   */
  Rpc.make("EditRef", {
    payload: {
      userId: UserId,
      refId: RefId,
      doc: Doc,
      expectedRowVersion: Schema.Int,
      message: Schema.NullOr(Schema.String),
      commitDraft: CommitDraft
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /**
   * Replaces an entity's tags. Tags are folders; the reserved tag "persona" is the
   * persona folder (DESIGN §2.2).
   */
  Rpc.make("SetEntityTags", {
    payload: { userId: UserId, entityId: EntityId, tags: Schema.Array(Schema.String) },
    success: Schema.Array(Schema.String),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Archives or restores an entity. Entities are never deleted. */
  Rpc.make("SetEntityArchived", {
    payload: { userId: UserId, entityId: EntityId, archived: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A new variant following `refId` (an upstream or another variant). */
  Rpc.make("ForkRef", {
    payload: { userId: UserId, refId: RefId, label: Schema.String, subtitle: Schema.String },
    success: LibraryRef,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /** Changes for one chat only, following `refId` (DESIGN §4). */
  Rpc.make("CreateChatOverride", {
    payload: { userId: UserId, refId: RefId, chatId: ChatId },
    success: LibraryRef,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /** Turns a chat override into a library variant (DESIGN §4). */
  Rpc.make("PromoteOverride", {
    payload: {
      userId: UserId,
      refId: RefId,
      label: Schema.String,
      subtitle: Schema.String,
      expectedRowVersion: Schema.Int
    },
    success: LibraryRef,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /**
   * A new upstream version (a re-import). Every ref following it merges the change in,
   * field by field with diff3 for text; conflicting ones are left as they were and
   * report `conflicts` (DATA-MODEL §3.2).
   */
  Rpc.make("ImportUpstream", {
    payload: {
      userId: UserId,
      refId: RefId,
      doc: Doc,
      sourcePath: Schema.NullOr(Schema.String),
      sourceHash: Schema.NullOr(Schema.String)
    },
    success: RefChange,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /** Merges in what the ref follows, if it can be done without conflicts. */
  Rpc.make("MergeFollowed", {
    payload: { userId: UserId, refId: RefId },
    success: Schema.Struct({ outcome: MergeOutcome, change: RefChange }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Commits a merge the user resolved by hand: `doc` merged with `theirsRevisionId`,
   * which must still be the followed ref's head.
   */
  Rpc.make("ResolveMerge", {
    payload: {
      userId: UserId,
      refId: RefId,
      doc: Doc,
      theirsRevisionId: RevisionId,
      expectedRowVersion: Schema.Int
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /**
   * A chat starts pending (DESIGN §2.1) unless created active. Participants join at
   * the initial position. An optional greeting becomes the root slot.
   */
  Rpc.make("CreateChat", {
    payload: {
      userId: UserId,
      kind: ChatKind,
      status: Schema.Literals(["pending", "active"]),
      title: Schema.String,
      participants: Schema.Array(EntityId),
      greeting: Schema.NullOr(NewVersion)
    },
    success: Chat,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Adds a slot under `parentSlotId` (null: a root) and makes it the chat's active
   * leaf. Appending under a slot that already has children is a branch (DESIGN §3.2).
   * The first message turns a pending chat active.
   */
  Rpc.make("AppendMessage", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      parentSlotId: Schema.NullOr(SlotId),
      version: NewVersion,
      commitDraft: CommitDraft
    },
    success: AppendResult,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A new version in place: a swipe, an edit, or "write your own" (DESIGN §3.1). */
  Rpc.make("AddVersion", {
    payload: { userId: UserId, slotId: SlotId, version: NewVersion, select: Schema.Boolean, commitDraft: CommitDraft },
    success: Version,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Changes which version a slot shows. Never touches any other slot (invariant 3). */
  Rpc.make("SelectVersion", {
    payload: { userId: UserId, slotId: SlotId, versionId: VersionId, expectedRowVersion: Schema.Int },
    success: Schema.Struct({ rowVersion: Schema.Int }),
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /**
   * Records a state change at a position: after `slotId` (null: the chat's initial
   * state), and if `versionId` is set, only while that version is selected.
   */
  Rpc.make("AddStateEvent", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      slotId: Schema.NullOr(SlotId),
      versionId: Schema.NullOr(VersionId),
      scope: Schema.NullOr(Schema.String),
      data: StateEventData,
      origin: StateEventOrigin
    },
    success: Schema.Struct({ id: Schema.String, seq: Schema.Int }),
    error: Schema.Union([NotFound, StorageError])
  })
) {}

export class ReadOps extends RpcGroup.make(
  Rpc.make("FindUserByHandle", {
    payload: { handle: Schema.String },
    success: Schema.NullOr(User),
    error: StorageError
  }),
  Rpc.make("GetChat", {
    payload: { userId: UserId, chatId: ChatId },
    success: Chat,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A window of the path ending at `leafSlotId` (null: the chat's active leaf): at most
   * `limit` slots, in root-to-leaf order, each with its selected version (DATA-MODEL
   * §4.4). The walk stops after `limit` slots, so the cost depends on the window, not on
   * the chat's length. Load older history by asking for the window ending at the
   * earliest entry's parent; `hasMore` says whether there is one.
   */
  Rpc.make("GetPath", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: Schema.NullOr(SlotId),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PATH_WINDOW }))
    },
    success: Schema.Struct({ entries: Schema.Array(PathEntry), hasMore: Schema.Boolean }),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("ListVersions", {
    payload: { userId: UserId, slotId: SlotId },
    success: Schema.Array(Version),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * The state events that apply at `slotId` (null: before the first message), in fold
   * order: initial events, then each slot on the path by depth, then by seq. Events
   * attached to a version count only while that version is selected (DATA-MODEL §5.2).
   */
  Rpc.make("StateEventsAt", {
    payload: { userId: UserId, chatId: ChatId, slotId: Schema.NullOr(SlotId) },
    success: Schema.Array(FoldableStateEvent),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("GetDraft", {
    payload: { userId: UserId, key: DraftKey },
    success: Schema.NullOr(Draft),
    error: StorageError
  }),
  /** Drafts with unsent text, most recently edited first. */
  Rpc.make("ListActiveDrafts", {
    payload: { userId: UserId },
    success: Schema.Array(Draft),
    error: StorageError
  }),
  /** The restorable states of a draft, newest first, without their full text. */
  Rpc.make("DraftHistory", {
    payload: {
      userId: UserId,
      key: DraftKey,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))
    },
    success: Schema.Array(DraftState),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The full text of one earlier state. */
  Rpc.make("GetDraftState", {
    payload: { userId: UserId, key: DraftKey, seq: Schema.Int },
    success: Schema.Struct({ seq: Schema.Int, content: Schema.String }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The user's library of one kind: upstream refs and variants, not chat overrides. */
  Rpc.make("ListLibrary", {
    payload: {
      userId: UserId,
      kind: EntityKind,
      /** Only entities with this tag, e.g. "persona" for the persona folder. */
      tag: Schema.NullOr(Schema.String),
      archived: Schema.Boolean
    },
    success: Schema.Array(LibraryRef),
    error: StorageError
  }),
  Rpc.make("GetRef", {
    payload: { userId: UserId, refId: RefId },
    success: Schema.Struct({ ref: LibraryRef, doc: Doc }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The ref's revisions, newest first, following first parents. */
  Rpc.make("RefHistory", {
    payload: { userId: UserId, refId: RefId, limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })) },
    success: Schema.Array(Revision),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** What merging in the followed ref would produce, for the conflict resolver. */
  Rpc.make("PreviewMerge", {
    payload: { userId: UserId, refId: RefId },
    success: MergePreview,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  Rpc.make("ListChatOverrides", {
    payload: { userId: UserId, chatId: ChatId },
    success: Schema.Array(LibraryRef),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Diagnostic: a CPU-bound query of `n` steps that touches no table. Used by tests. */
  Rpc.make("CountTo", {
    payload: { n: Schema.Int },
    success: Schema.Int,
    error: StorageError
  })
) {}
