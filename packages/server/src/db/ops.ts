// Storage operations, executed inside the database worker threads (ARCHITECTURE.md §3).
// Each write operation runs as one synchronous transaction inside the writer worker,
// so a transaction can never span an await or a network call.
//
// Every operation on owned data takes the acting user and only touches rows that user
// owns (DATA-MODEL §1, principle 6). Rows owned by someone else are reported as
// NotFound, so their existence doesn't leak.
import { Chat, ChatId, ChatKind, EntityId, NewVersion, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import { User, UserId } from "@rp/shared/domain.ts"
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

export const StateEventOrigin = Schema.Literals(["user", "rollout", "changeset", "import"])

export class FoldableStateEvent extends Schema.Class<FoldableStateEvent>("FoldableStateEvent")({
  scope: Schema.NullOr(Schema.String),
  data: StateEventData
}) {}

export class AppendResult extends Schema.Class<AppendResult>("AppendResult")({
  slotId: SlotId,
  version: Version,
  chat: Chat
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
   * A new library entity with its first revision and its base ref. Minimal for now:
   * variants, chat overrides and re-import merges come with the library work.
   */
  Rpc.make("CreateEntity", {
    payload: {
      userId: UserId,
      kind: Schema.Literals(["card", "preset", "lorebook", "note", "preset_overlay"]),
      label: Schema.String,
      doc: Schema.Unknown,
      schemaVersion: Schema.Int
    },
    success: Schema.Struct({ entityId: EntityId, revisionId: Schema.String, refId: Schema.String }),
    error: StorageError
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
    payload: { userId: UserId, chatId: ChatId, parentSlotId: Schema.NullOr(SlotId), version: NewVersion },
    success: AppendResult,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A new version in place: a swipe, an edit, or "write your own" (DESIGN §3.1). */
  Rpc.make("AddVersion", {
    payload: { userId: UserId, slotId: SlotId, version: NewVersion, select: Schema.Boolean },
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
  /** Diagnostic: a CPU-bound query of `n` steps that touches no table. Used by tests. */
  Rpc.make("CountTo", {
    payload: { n: Schema.Int },
    success: Schema.Int,
    error: StorageError
  })
) {}
