// Storage operations, executed inside the database worker threads (ARCHITECTURE.md §3).
// Each write operation runs as one synchronous transaction inside the writer worker,
// so a transaction can never span an await or a network call.
//
// Every operation on owned data takes the acting user and only touches rows that user
// owns (DATA-MODEL §1, principle 6). Rows owned by someone else are reported as
// NotFound, so their existence doesn't leak.
import { Chat, ChatId, ChatKind, EntityId, NewVersion, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import { User, UserId } from "@rp/shared/domain.ts"
import { BinItem, RecoveredText } from "@rp/shared/bin.ts"
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
import {
  Connection,
  ConnectionId,
  ConnectionSettings,
  Model,
  ModelId,
  ModelOverrides,
  ModelUpstream,
  ProviderKind,
  ProxyMode
} from "@rp/shared/providers.ts"
import { StateEventData } from "@rp/shared/state.ts"
import {
  Cost,
  LlmRequest,
  LlmRequestId,
  RequestPurpose,
  RequestStatus,
  TokenCounts,
  UsageSource
} from "@rp/shared/usage.ts"
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

/** A model with this key already exists on the connection. */
export class ModelKeyTaken extends Schema.TaggedError<ModelKeyTaken>()("ModelKeyTaken", {
  connectionId: Schema.String,
  key: Schema.String
}) {}

/** An encrypted secret and what may be shown of it. */
const EncryptedKey = Schema.Struct({ enc: Schema.Uint8Array, hint: Schema.String })
const EncryptedHeaders = Schema.Struct({ enc: Schema.Uint8Array, names: Schema.Array(Schema.String) })

/**
 * What the provider layer needs to send a request on a connection, secrets still
 * encrypted. Never sent to a browser: the main thread decrypts them for one request.
 */
export class ConnectionForRequest extends Schema.Class<ConnectionForRequest>("ConnectionForRequest")({
  connection: Connection,
  apiKeyEnc: Schema.NullOr(Schema.Uint8Array),
  headersEnc: Schema.NullOr(Schema.Uint8Array),
  proxyUrlEnc: Schema.NullOr(Schema.Uint8Array)
}) {}

/** Opens a ledger row before a request is sent (PROVIDERS §9.1). */
export const OpenLlmRequest = Schema.Struct({
  id: LlmRequestId,
  connectionId: ConnectionId,
  modelId: Schema.NullOr(ModelId),
  chatId: Schema.NullOr(ChatId),
  rolloutId: Schema.NullOr(Schema.String),
  versionId: Schema.NullOr(VersionId),
  purpose: RequestPurpose,
  api: Schema.String,
  provider: Schema.String,
  modelKey: Schema.String,
  startedAt: Schema.Number
})

/** Closes a ledger row with what the request produced. */
export const CloseLlmRequest = Schema.Struct({
  id: LlmRequestId,
  status: RequestStatus,
  endedAt: Schema.Number,
  firstTokenAt: Schema.NullOr(Schema.Number),
  responseModel: Schema.NullOr(Schema.String),
  upstream: Schema.NullOr(Schema.String),
  counts: TokenCounts,
  usageSource: UsageSource,
  rawUsage: Schema.NullOr(Schema.Unknown),
  reportedCost: Schema.NullOr(Schema.Number),
  cost: Schema.NullOr(Cost),
  error: Schema.NullOr(Schema.Unknown)
})

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
  // --- Recycle bin (DESIGN §6.2). Deletes need no confirmation: each returns the bin
  // item for the "deleted, open the bin" toast, and can be undone from the bin.
  Rpc.make("DeleteChat", {
    payload: { userId: UserId, chatId: ChatId },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Deletes one message; its replies stay. */
  Rpc.make("DeleteMessage", {
    payload: { userId: UserId, slotId: SlotId },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Deletes a message and everything after it on every branch below it. */
  Rpc.make("DeleteBranch", {
    payload: { userId: UserId, slotId: SlotId },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Deletes one swipe: the normal delete (owner, 2026-10-10). If it was showing, the
   * previous swipe shows. A message's only remaining version takes the message with it.
   */
  Rpc.make("DeleteVersion", {
    payload: { userId: UserId, versionId: VersionId },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("DeleteEntity", {
    payload: { userId: UserId, entityId: EntityId },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Puts a deleted item back exactly where it was. */
  Rpc.make("RestoreBinItem", {
    payload: { userId: UserId, itemId: Schema.String },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Deletes an item for good. The UI confirms this one. */
  Rpc.make("PurgeBinItem", {
    payload: { userId: UserId, itemId: Schema.String },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("EmptyBin", {
    payload: { userId: UserId },
    success: Schema.Struct({ purged: Schema.Int }),
    error: StorageError
  }),
  Rpc.make("DeleteRecoveredText", {
    payload: { userId: UserId, id: Schema.String },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("ClearRecoveredTexts", {
    payload: { userId: UserId },
    success: Schema.Struct({ deleted: Schema.Int }),
    error: StorageError
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
  // --- Connections and models (spec/PROVIDERS.md §2, §3). Secrets arrive encrypted:
  // the main thread holds the server secret, the workers only see ciphertext.
  /** The id is chosen by the caller, because secrets are encrypted bound to it. */
  Rpc.make("CreateConnection", {
    payload: { userId: UserId, connectionId: ConnectionId, kind: ProviderKind, settings: ConnectionSettings },
    success: Connection,
    error: StorageError
  }),
  Rpc.make("UpdateConnection", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      settings: ConnectionSettings,
      expectedRowVersion: Schema.Int
    },
    success: Connection,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /** Sets or clears (null) the API key. Nothing ever reads it back out to a client. */
  Rpc.make("SetConnectionKey", {
    payload: { userId: UserId, connectionId: ConnectionId, key: Schema.NullOr(EncryptedKey) },
    success: Connection,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("SetConnectionHeaders", {
    payload: { userId: UserId, connectionId: ConnectionId, headers: Schema.NullOr(EncryptedHeaders) },
    success: Connection,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The per-connection proxy override (PROVIDERS §6.2); a URL only with `custom`. */
  Rpc.make("SetConnectionProxy", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      mode: ProxyMode,
      urlEnc: Schema.NullOr(Schema.Uint8Array)
    },
    success: Connection,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("DeleteConnection", {
    payload: { userId: UserId, connectionId: ConnectionId },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Applies a fetched model list: new models are added, known ones get the fresh
   * upstream data, and ones the list no longer reports are marked missing, never
   * deleted. User edits are never touched.
   */
  Rpc.make("SyncFetchedModels", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      models: Schema.Array(Schema.Struct({ key: Schema.String, upstream: ModelUpstream })),
      fetchedAt: Schema.Number
    },
    success: Schema.Struct({ added: Schema.Int, updated: Schema.Int, missing: Schema.Int }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A model added by hand, for endpoints without a list or models the list leaves out. */
  Rpc.make("AddUserModel", {
    payload: { userId: UserId, connectionId: ConnectionId, key: Schema.String, overrides: ModelOverrides },
    success: Model,
    error: Schema.Union([NotFound, ModelKeyTaken, StorageError])
  }),
  /** Replaces the user's edits to a model. */
  Rpc.make("EditModel", {
    payload: { userId: UserId, modelId: ModelId, overrides: ModelOverrides, expectedRowVersion: Schema.Int },
    success: Model,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  Rpc.make("SetModelHidden", {
    payload: { userId: UserId, modelId: ModelId, hidden: Schema.Boolean },
    success: Model,
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- The usage ledger (PROVIDERS §9.1).
  Rpc.make("OpenLlmRequest", {
    payload: { userId: UserId, request: OpenLlmRequest },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("CloseLlmRequest", {
    payload: { userId: UserId, request: CloseLlmRequest },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** At startup: requests left running by a crash may have been billed, so they're kept as interrupted. */
  Rpc.make("InterruptRunningLlmRequests", {
    success: Schema.Struct({ interrupted: Schema.Int }),
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
  /** The bin's deleted items, newest first. `before` pages back by deletion time. */
  Rpc.make("ListBin", {
    payload: {
      userId: UserId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.NullOr(Schema.Number)
    },
    success: Schema.Array(BinItem),
    error: StorageError
  }),
  /** The bin's recovered text, newest first, with excerpts; optionally only from one draft. */
  Rpc.make("ListRecoveredTexts", {
    payload: {
      userId: UserId,
      source: Schema.NullOr(DraftKey),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
    },
    success: Schema.Array(RecoveredText),
    error: StorageError
  }),
  Rpc.make("GetRecoveredText", {
    payload: { userId: UserId, id: Schema.String },
    success: RecoveredText,
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
  Rpc.make("ListConnections", {
    payload: { userId: UserId },
    success: Schema.Array(Connection),
    error: StorageError
  }),
  Rpc.make("GetConnection", {
    payload: { userId: UserId, connectionId: ConnectionId },
    success: Connection,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** For the provider layer only: the connection with its encrypted secrets. */
  Rpc.make("ResolveConnection", {
    payload: { userId: UserId, connectionId: ConnectionId },
    success: ConnectionForRequest,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("ListModels", {
    payload: { userId: UserId, connectionId: ConnectionId, includeHidden: Schema.Boolean },
    success: Schema.Array(Model),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("GetModel", {
    payload: { userId: UserId, modelId: ModelId },
    success: Model,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The user's requests, newest first. `before` pages back by start time. */
  Rpc.make("ListLlmRequests", {
    payload: {
      userId: UserId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
      before: Schema.NullOr(Schema.Number)
    },
    success: Schema.Array(LlmRequest),
    error: StorageError
  }),
  /** Diagnostic: a CPU-bound query of `n` steps that touches no table. Used by tests. */
  Rpc.make("CountTo", {
    payload: { n: Schema.Int },
    success: Schema.Int,
    error: StorageError
  })
) {}
