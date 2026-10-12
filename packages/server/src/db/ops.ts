// Storage operations, executed inside the database worker threads (ARCHITECTURE.md §3).
// Each write operation runs as one synchronous transaction inside the writer worker,
// so a transaction can never span an await or a network call.
//
// Every operation on owned data takes the acting user and only touches rows that user
// owns (DATA-MODEL §1, principle 6). Rows owned by someone else are reported as
// NotFound, so their existence doesn't leak.
import { Chat, ChatId, ChatKind, EntityId, NewVersion, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import { VersionError, VersionStatus } from "@rp/shared/chat.ts"
import { NotAmendable, PathRange, PathWindow } from "@rp/shared/chatApi.ts"
import { User, UserAccount, UserId, UserRole } from "@rp/shared/domain.ts"
import { BinItem, RecoveredText } from "@rp/shared/bin.ts"
import { Draft, DraftKey, DraftState } from "@rp/shared/drafts.ts"
import { AccountRejected, LeafMoved, ModelKeyTaken, NotFound, StaleWrite } from "@rp/shared/errors.ts"
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
import { LibraryImport } from "@rp/shared/libraryImport.ts"
import {
  Connection,
  ConnectionId,
  ConnectionSettings,
  Credential,
  CredentialId,
  Model,
  ModelId,
  ModelOverrides,
  ModelUpstream,
  ProviderKind,
  ProxyMode
} from "@rp/shared/providers.ts"
import { FoldableEvent, StateEventData } from "@rp/shared/state.ts"
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
import { CastCard, FrozenMacros, QueuedMessage } from "@rp/shared/chat.ts"
import { CardForChat, FirstTurn } from "@rp/shared/chatSetupApi.ts"

const StorageErrorReason = Schema.Literals(["busy", "constraint", "corrupt", "other"])

/** A disabled user, refused before it can act. */
export class UserDisabled extends Schema.TaggedError<UserDisabled>()("UserDisabled", { handle: Schema.String }) {}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  reason: StorageErrorReason,
  operation: Schema.String,
  message: Schema.String
}) {}

// Shared with the client, so the tags reach the UI unchanged.
export { LeafMoved, ModelKeyTaken, NotFound, StaleWrite } from "@rp/shared/errors.ts"

/** The largest path window one GetPath returns. */
const MAX_PATH_WINDOW = 1000

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

/** What merging a ref did, and the change that flowed on from it. */
const MergeAndFlow = Schema.Struct({ outcome: MergeOutcome, change: RefChange })

export class DraftTooLarge extends Schema.TaggedError<DraftTooLarge>()("DraftTooLarge", {
  length: Schema.Int,
  max: Schema.Int
}) {}

/**
 * Marks the draft a write came from as committed, in the same transaction, so a reload
 * never shows text that was already sent. If the draft moved on since (another tab kept
 * typing), it stays active: it holds newer text than what was committed.
 */
const CommitDraft = Schema.NullOr(Schema.Struct({ key: DraftKey, expectedRowVersion: Schema.Int }))

export class AppendResult extends Schema.Class<AppendResult>("AppendResult")({
  slotId: SlotId,
  version: Version,
  chat: Chat,
  /** The committed draft, or the draft left active because it moved on; null if none was given. */
  draft: Schema.NullOr(Draft)
}) {}

/** An encrypted secret and what may be shown of it. */
const EncryptedKey = Schema.Struct({ enc: Schema.Uint8Array, hint: Schema.String })
/** Header values, encrypted, and the origin they were set for. */
const EncryptedHeaders = Schema.Struct({
  enc: Schema.Uint8Array,
  names: Schema.Array(Schema.String),
  origin: Schema.String
})
/** A key typed into a connection, stored as a credential that connection owns. */
const NewCredential = Schema.Struct({
  credentialId: CredentialId,
  name: Schema.String,
  key: EncryptedKey,
  origins: Schema.Array(Schema.String)
})

/**
 * What the provider layer needs to send a request on a connection, secrets still
 * encrypted. Never sent to a browser: the main thread decrypts them for one request.
 */
export class ConnectionForRequest extends Schema.Class<ConnectionForRequest>("ConnectionForRequest")({
  connection: Connection,
  /** The credential's key and the origins it may be sent to. */
  credential: Schema.NullOr(
    Schema.Struct({ id: CredentialId, keyEnc: Schema.Uint8Array, origins: Schema.Array(Schema.String) })
  ),
  headersEnc: Schema.NullOr(Schema.Uint8Array),
  /** The origin the headers were set for; null for headers from before 0008. */
  headersOrigin: Schema.NullOr(Schema.String),
  proxyUrlEnc: Schema.NullOr(Schema.Uint8Array),
  ownerRole: UserRole
}) {}

/** A position in the ledger's newest-first order; start times alone can tie. */
const LedgerCursor = Schema.Struct({ startedAt: Schema.Number, id: Schema.String })

/** Opens a ledger row before a request is sent (PROVIDERS §9.1). */
const OpenLlmRequest = Schema.Struct({
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
const CloseLlmRequest = Schema.Struct({
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

// --- Library import
export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** A file that came with an imported one, already written to media storage. */
export const ImportedMedia = Schema.Struct({
  /** The avatar, or an embedded asset named by `uri` in the card's assets. */
  role: Schema.Literals(["avatar", "asset"]),
  uri: Schema.String,
  sha256: Sha256,
  mime: Schema.String,
  byteSize: Schema.Int,
  width: Schema.NullOr(Schema.Int),
  height: Schema.NullOr(Schema.Int)
})

/** A stored file, at `path` under the data directory. */
const StoredFile = Schema.Struct({ path: Schema.String, mime: Schema.String, byteSize: Schema.Int })

/** What the send queue did behind a slot (chatSetupWrites.ts). */
export const QueueOutcome = Schema.Struct({
  chatId: ChatId,
  /** Slots the queue posted, in order, the next reply's last. */
  posted: Schema.Array(SlotId),
  next: Schema.NullOr(Schema.Struct({ slotId: SlotId, versionId: VersionId })),
  /** Entries withdrawn because their reply went to the bin. */
  withdrawn: Schema.Int,
  /** Whether the chat's queue changed, and what's left of it. */
  queueChanged: Schema.Boolean,
  queue: Schema.Array(QueuedMessage)
})

export class ExportSource extends Schema.Class<ExportSource>("ExportSource")({
  kind: EntityKind,
  label: Schema.String,
  docJson: Schema.String,
  noteDocJson: Schema.NullOr(Schema.String),
  avatar: Schema.NullOr(StoredFile),
  /** Embedded assets, by the `uri` the card's assets name them with. */
  assets: Schema.Array(Schema.Struct({ ...StoredFile.fields, uri: Schema.String }))
}) {}

export class WriteOps extends RpcGroup.make(
  /** Answers once the writer has opened the database and run migrations. */
  Rpc.make("Ready"),
  /** The user with this handle, created on first sight. A disabled user is refused. */
  Rpc.make("EnsureUser", {
    payload: { handle: Schema.String, displayName: Schema.String },
    success: User,
    error: Schema.Union([StorageError, UserDisabled])
  }),
  // --- Accounts (DESIGN §10.1). Passwords arrive already hashed.
  Rpc.make("CreateUser", {
    payload: { handle: Schema.String, displayName: Schema.String, role: UserRole, passwordHash: Schema.String },
    success: UserAccount,
    error: Schema.Union([StorageError, AccountRejected])
  }),
  /** Sets a password and ends every session of the user. */
  Rpc.make("SetPasswordHash", {
    payload: { userId: UserId, passwordHash: Schema.String },
    success: Schema.Void,
    error: Schema.Union([StorageError, NotFound])
  }),
  /** Disabling ends the user's sessions. The last enabled admin can't be disabled. */
  Rpc.make("SetUserDisabled", {
    payload: { userId: UserId, disabled: Schema.Boolean },
    success: UserAccount,
    error: Schema.Union([StorageError, NotFound, AccountRejected])
  }),
  /**
   * The first admin's password from the environment, applied only while no enabled admin
   * has one. Names an existing user, or creates it as admin; with no handle, the oldest
   * enabled admin, else a new "admin". Returns the user, or null when it didn't apply.
   */
  Rpc.make("BootstrapAdmin", {
    payload: { handle: Schema.NullOr(Schema.String), passwordHash: Schema.String },
    success: Schema.NullOr(User),
    error: StorageError
  }),
  /** Also clears expired sessions. */
  Rpc.make("CreateSession", {
    payload: { tokenHash: Schema.String, userId: UserId, expiresAt: Schema.Number },
    success: Schema.Void,
    error: StorageError
  }),
  Rpc.make("DeleteSession", { payload: { tokenHash: Schema.String }, success: Schema.Void, error: StorageError }),
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
  /**
   * Ends a draft's session as committed or discarded: empties its text and deletes its
   * history, sending text that would be lost to the bin's recovered-text section.
   */
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
  /** Archives or restores an entity. */
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
  /** Merges in what the ref follows, if it can be done without conflicts. */
  Rpc.make("MergeFollowed", {
    payload: { userId: UserId, refId: RefId },
    success: MergeAndFlow,
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
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      kind: ProviderKind,
      /** The kind's wire API, resolved by the provider registry on the main thread. */
      api: Schema.String,
      settings: ConnectionSettings,
      /** An existing credential, or a typed key stored with the connection in one transaction. */
      credential: Schema.Union([
        Schema.Struct({ existing: Schema.NullOr(CredentialId) }),
        Schema.Struct({ typed: NewCredential })
      ])
    },
    success: Connection,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A key typed for a connection, or none. The connection's previous key goes if the
   * connection owned it and nothing else uses it. The row version is the one the user
   * saw, so a key isn't bound to a base URL someone changed in the meantime.
   */
  Rpc.make("SetConnectionKey", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      expectedRowVersion: Schema.Int,
      credential: Schema.NullOr(NewCredential)
    },
    success: Connection,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
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
  /** Which credential the connection uses, or none. */
  Rpc.make("SetConnectionCredential", {
    payload: { userId: UserId, connectionId: ConnectionId, credentialId: Schema.NullOr(CredentialId) },
    success: Connection,
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- Credentials (PROVIDERS §5): keys stored once, bound to origins. The key arrives
  // encrypted; the main thread checks a retyped key before an origin is added.
  Rpc.make("CreateCredential", {
    payload: {
      userId: UserId,
      credentialId: CredentialId,
      name: Schema.String,
      key: EncryptedKey,
      origins: Schema.Array(Schema.String)
    },
    success: Credential,
    error: StorageError
  }),
  Rpc.make("RenameCredential", {
    payload: { userId: UserId, credentialId: CredentialId, name: Schema.String },
    success: Credential,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A new key for the same credential: every connection using it gets the new one. */
  Rpc.make("ReplaceCredentialKey", {
    /** A new key gets its origins stated again: approvals given for the old key don't carry over. */
    payload: { userId: UserId, credentialId: CredentialId, key: EncryptedKey, origins: Schema.Array(Schema.String) },
    success: Credential,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("AddCredentialOrigin", {
    payload: { userId: UserId, credentialId: CredentialId, origin: Schema.String },
    success: Credential,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Deletes a credential; connections using it are left without a key. */
  Rpc.make("DeleteCredential", {
    payload: { userId: UserId, credentialId: CredentialId },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("SetConnectionHeaders", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      expectedRowVersion: Schema.Int,
      headers: Schema.NullOr(EncryptedHeaders)
    },
    success: Connection,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
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
  /** Instance-wide settings (admin). Callers check the role; storage doesn't know it. */
  Rpc.make("SetAppSetting", {
    payload: { key: Schema.String, value: Schema.Unknown },
    success: Schema.Void,
    error: StorageError
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
   * leaf. The first message turns a pending chat active.
   *
   * A branch is explicit (DESIGN §3.2): without `branch`, the parent must be the chat's
   * active leaf, so a tab that missed a newer message gets LeafMoved (with the current
   * leaf) instead of silently forking the conversation.
   */
  Rpc.make("AppendMessage", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      parentSlotId: Schema.NullOr(SlotId),
      branch: Schema.Boolean,
      version: NewVersion,
      commitDraft: CommitDraft
    },
    success: AppendResult,
    error: Schema.Union([NotFound, LeafMoved, StorageError])
  }),
  /**
   * A new version in place: a swipe, an edit, or "write your own" (DESIGN §3.1). An
   * edit's `sourceVersionId` is a live version of the same slot. A new slot's first
   * version has no source.
   */
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
   * Records a user's state change (origin `user`) at a position: after `slotId` (null:
   * the chat's initial state), and if `versionId` is set, only while that version is
   * selected. Every entity, ref, revision, connection and model the value names must be
   * the user's (NotFound otherwise). Events from rollouts, changesets and imports are
   * written by the operations that perform those.
   */
  Rpc.make("AddStateEvent", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      slotId: Schema.NullOr(SlotId),
      versionId: Schema.NullOr(VersionId),
      scope: FoldableEvent.fields.scope,
      data: StateEventData
    },
    success: Schema.Struct({ id: Schema.String, seq: Schema.Int }),
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- Library import (ARCHITECTURE.md §11). The file was parsed in a format worker;
  // documents cross as JSON text, which costs the main thread a copy, not a walk.
  /**
   * A parsed file into the library: a new entity with an upstream ref, or, with
   * `intoRefId`, a new import of that upstream, merged into it and its followers. The
   * file's media are recorded first, so the card document can name them. A card's
   * Character's Note becomes (or updates) the card's first note.
   */
  Rpc.make("ImportFile", {
    payload: {
      userId: UserId,
      intoRefId: Schema.NullOr(RefId),
      kind: EntityKind,
      label: Schema.String,
      docJson: Schema.String,
      /**
       * The document's content hash and search text, worked out in the format worker, so a
       * large file doesn't hold the writer for them. Used unless the media change the document.
       */
      docHash: Schema.String,
      searchText: Schema.String,
      schemaVersion: Schema.Int,
      /** The uploaded file's name and the SHA-256 of its bytes. */
      sourceName: Schema.String,
      sourceHash: Sha256,
      media: Schema.Array(ImportedMedia),
      /** A note document without its owner, which is the card. */
      noteDocJson: Schema.NullOr(Schema.String)
    },
    success: LibraryImport,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  // --- Chats: the chat RPCs beyond the graph operations above (writes.ts).
  /**
   * A new version of a slot, selected, if the slot is still at the row version the user
   * saw: a swipe, an edit saved as a new version, or the user's own version.
   */
  Rpc.make("AddSelectedVersion", {
    payload: { userId: UserId, slotId: SlotId, version: NewVersion, expectedRowVersion: Schema.Int },
    success: Schema.Struct({ chatId: ChatId, version: Version }),
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /** Changes a finished user-written version in place; the trigger keeps the earlier text. */
  Rpc.make("AmendVersion", {
    payload: { userId: UserId, versionId: VersionId, content: Schema.String, expectedRowVersion: Schema.Int },
    success: Version,
    error: Schema.Union([NotFound, StaleWrite, NotAmendable, StorageError])
  }),
  /**
   * A generating version's text so far (status `generating`) or its final text and status.
   * Only a model version still generating is written; a version in the bin still is, so
   * restoring it brings its text back.
   */
  Rpc.make("SaveGeneration", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      content: Schema.String,
      status: VersionStatus,
      error: Schema.NullOr(VersionError)
    },
    success: Version,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * At startup: versions a previous process left generating keep their text as
   * interrupted, and the send queue drains (`queued`: entries posted or dropped, below).
   */
  Rpc.make("InterruptGenerations", {
    success: Schema.Struct({ interrupted: Schema.Int, queued: Schema.Int }),
    error: StorageError
  }),

  // --- Chat setup, speakers and the send queue (chatSetupWrites.ts; DESIGN §2.1, §2.2).
  /**
   * A chat made from cards on its first turn: the cards and the persona join at the
   * start, the persona is played by the user, every greeting of the first card becomes a
   * version of the first message (`greeting` selected), then the first turn.
   */
  Rpc.make("StartChat", {
    payload: {
      userId: UserId,
      cards: Schema.Array(EntityId),
      persona: Schema.NullOr(EntityId),
      greeting: Schema.NullOr(Schema.Int),
      first: FirstTurn,
      frozen: Schema.Array(FrozenMacros)
    },
    success: AppendResult,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A message (or, `generate`, a reply) under `parentSlotId`: posted, or queued when the
   * parent's selected version is still generating (DESIGN §2.2).
   */
  Rpc.make("SendOrQueue", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      parentSlotId: Schema.NullOr(SlotId),
      branch: Schema.Boolean,
      kind: Schema.Literals(["message", "generate"]),
      content: Schema.String,
      speakerEntityId: Schema.NullOr(EntityId),
      /** For a message that's queued: who replies once it posts. */
      replySpeakerEntityId: Schema.NullOr(EntityId),
      direction: Schema.NullOr(Schema.String)
    },
    success: Schema.Union([
      Schema.TaggedStruct("Posted", { result: AppendResult }),
      Schema.TaggedStruct("Queued", { queued: QueuedMessage, queue: Schema.Array(QueuedMessage) })
    ]),
    error: Schema.Union([NotFound, LeafMoved, StorageError])
  }),
  Rpc.make("EditQueued", {
    payload: {
      userId: UserId,
      queuedId: Schema.String,
      content: Schema.String,
      speakerEntityId: Schema.NullOr(EntityId),
      expectedRowVersion: Schema.Int
    },
    success: Schema.Struct({ queued: QueuedMessage, queue: Schema.Array(QueuedMessage) }),
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  Rpc.make("WithdrawQueued", {
    payload: { userId: UserId, queuedId: Schema.String, expectedRowVersion: Schema.Int },
    success: Schema.Struct({ queued: QueuedMessage, queue: Schema.Array(QueuedMessage) }),
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /**
   * SelectVersion, and in the same transaction the queue behind the slot: a selected
   * version that isn't generating lets it post, as a generation's end does.
   */
  Rpc.make("SelectAndDrain", {
    payload: { userId: UserId, slotId: SlotId, versionId: VersionId, expectedRowVersion: Schema.Int },
    success: QueueOutcome,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /**
   * A generation's end: its final text and status, as SaveGeneration, and in the same
   * transaction the send queue behind its slot. Once the slot's selected version isn't
   * generating, the first entry posts after it; a message gets a reply of its own
   * (`next`, generating, which the caller starts), and the rest wait for that reply. A
   * slot gone to the bin withdraws its entries.
   */
  /** Adds the card to the persona folder or takes it out, keeping its other folders. */
  Rpc.make("SetPersona", {
    payload: { userId: UserId, entityId: EntityId, persona: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("FinishGeneration", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      content: Schema.String,
      status: VersionStatus,
      error: Schema.NullOr(VersionError)
    },
    success: Schema.Struct({ ...QueueOutcome.fields, version: Version }),
    error: Schema.Union([NotFound, StorageError])
  })
) {}

export class ReadOps extends RpcGroup.make(
  Rpc.make("FindUserByHandle", {
    payload: { handle: Schema.String },
    success: Schema.NullOr(User),
    error: StorageError
  }),
  // --- Accounts (DESIGN §10.1). Only enabled users can log in or hold a session.
  /** The enabled user a live session belongs to. */
  Rpc.make("GetSessionUser", {
    payload: { tokenHash: Schema.String, now: Schema.Number },
    success: Schema.NullOr(User),
    error: StorageError
  }),
  /** An enabled user and their password hash, by handle or by id, for checking a password. */
  Rpc.make("GetPasswordHash", {
    payload: Schema.Union([Schema.Struct({ handle: Schema.String }), Schema.Struct({ userId: UserId })]),
    success: Schema.NullOr(Schema.Struct({ user: User, passwordHash: Schema.NullOr(Schema.String) })),
    error: StorageError
  }),
  Rpc.make("ListUsers", { success: Schema.Array(UserAccount), error: StorageError }),
  /** Whether any enabled user has a password, which makes login required (DESIGN §10.1). */
  Rpc.make("AccountsConfigured", { success: Schema.Boolean, error: StorageError }),
  /** The oldest enabled admin: who loopback acts as when it's exempt from login. */
  Rpc.make("FirstAdmin", { success: Schema.NullOr(User), error: StorageError }),
  Rpc.make("GetChat", {
    payload: { userId: UserId, chatId: ChatId },
    success: Chat,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A window of the path ending at `leafSlotId` (null: the chat's active leaf): at most
   * `limit` slots, in root-to-leaf order, each with its selected version (DATA-MODEL
   * §4.4). The walk stops after `limit` slots, so the cost depends on the window, not on
   * the chat's length. Deleted messages count toward `limit` but aren't returned, so a
   * window can hold fewer entries, even none. `olderLeafSlotId` is the leaf of the next
   * older window, null at the root.
   */
  Rpc.make("GetPath", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: Schema.NullOr(SlotId),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PATH_WINDOW }))
    },
    success: Schema.Struct({ entries: Schema.Array(PathEntry), olderLeafSlotId: Schema.NullOr(SlotId) }),
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
   * Events on a deleted message don't apply until it's restored. Events naming a library
   * entity, ref or revision that was deleted for good are left out (played_by_me.set
   * keeps its other entities).
   */
  Rpc.make("StateEventsAt", {
    payload: { userId: UserId, chatId: ChatId, slotId: Schema.NullOr(SlotId) },
    success: Schema.Array(FoldableEvent),
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
  /** The bin's deleted items, newest first. `before` pages back from the last item seen. */
  Rpc.make("ListBin", {
    payload: {
      userId: UserId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.NullOr(Schema.Struct({ deletedAt: Schema.Number, id: Schema.String }))
    },
    success: Schema.Array(BinItem),
    error: StorageError
  }),
  /**
   * The bin's recovered text, newest first, with excerpts; optionally only from one draft.
   * `before` pages back from the last text seen.
   */
  Rpc.make("ListRecoveredTexts", {
    payload: {
      userId: UserId,
      source: Schema.NullOr(DraftKey),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.NullOr(Schema.Struct({ createdAt: Schema.Number, id: Schema.String }))
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
  Rpc.make("ListCredentials", {
    payload: { userId: UserId },
    success: Schema.Array(Credential),
    error: StorageError
  }),
  /** For the provider layer only: a credential's encrypted key, to check a retyped one. */
  Rpc.make("ResolveCredential", {
    payload: { userId: UserId, credentialId: CredentialId },
    success: Schema.Struct({ keyEnc: Schema.Uint8Array }),
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
  Rpc.make("GetAppSetting", {
    payload: { key: Schema.String },
    success: Schema.NullOr(Schema.Unknown),
    error: StorageError
  }),
  /** The user's requests, newest first. `before` is the last row of the previous page. */
  Rpc.make("ListLlmRequests", {
    payload: {
      userId: UserId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
      before: Schema.NullOr(LedgerCursor)
    },
    success: Schema.Array(LlmRequest),
    error: StorageError
  }),
  // --- Library import (ARCHITECTURE.md §11).
  /**
   * What exporting a ref takes: its head document, its card's first note, and the stored
   * files the document names that the user holds a reference to.
   */
  Rpc.make("ExportSource", {
    payload: { userId: UserId, refId: RefId },
    success: ExportSource,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A ref without its document, to check where an import goes before reading the file. */
  Rpc.make("GetLibraryRef", {
    payload: { userId: UserId, refId: RefId },
    success: LibraryRef,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Whether a row names the file with this SHA-256: the sweep asks just before deleting. */
  Rpc.make("IsMediaRecorded", {
    payload: { sha256: Schema.String },
    success: Schema.Boolean,
    error: StorageError
  }),
  /** Every stored file's SHA-256, for the sweep of files no row names. */
  Rpc.make("ListMediaHashes", {
    success: Schema.Array(Schema.String),
    error: StorageError
  }),
  // --- Chats: the chat RPCs beyond the graph operations above (reads.ts).
  /** The user's chats, most recent first (DESIGN §2.1: by last message, else creation). */
  Rpc.make("ListChats", {
    payload: {
      userId: UserId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.NullOr(Schema.Struct({ at: Schema.Number, id: ChatId }))
    },
    success: Schema.Array(Chat),
    error: StorageError
  }),
  /** A window of a path, in either direction from where the client is (chatApi.ts). */
  Rpc.make("ReadPath", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: Schema.NullOr(SlotId),
      range: PathRange,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PATH_WINDOW }))
    },
    success: PathWindow,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** One of the user's live versions: not in the bin, nor its message or chat. */
  Rpc.make("GetVersion", {
    payload: { userId: UserId, versionId: VersionId },
    success: Version,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** One live slot with its selected version, as a path shows it, and its chat. */
  Rpc.make("GetSlot", {
    payload: { userId: UserId, slotId: SlotId },
    success: Schema.Struct({ chatId: ChatId, entry: PathEntry }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Which of these versions are the user's and live: not in the bin, nor their message or chat. */
  Rpc.make("LiveVersions", {
    payload: { userId: UserId, versionIds: Schema.Array(VersionId) },
    success: Schema.Array(VersionId),
    error: StorageError
  }),

  // --- Chat setup, speakers and the send queue (chatSetupReads.ts; DESIGN §2.1, §2.2).
  /** The user's live cards, by label. */
  Rpc.make("ListCards", { payload: { userId: UserId }, success: Schema.Array(CastCard), error: StorageError }),
  /** These cards, as far as they're the user's (binned ones included); others are left out. */
  Rpc.make("CastCards", {
    payload: { userId: UserId, entityIds: Schema.Array(EntityId) },
    success: Schema.Array(CastCard),
    error: StorageError
  }),
  Rpc.make("GetCardForChat", {
    payload: { userId: UserId, entityId: EntityId },
    success: CardForChat,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("ListQueued", {
    payload: { userId: UserId, chatId: ChatId },
    success: Schema.Array(QueuedMessage),
    error: Schema.Union([NotFound, StorageError])
  })
) {}
