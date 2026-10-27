import { PlannedJob, SummaryJob, SummaryChunk, SummaryPlan } from "./lcmJobs.ts"
import { ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import { LcmSettingsChange, ModelChoice } from "@rp/shared/lcmSettings.ts"
import {
  LcmCoverage,
  LcmState,
  RerunTarget,
  Summary,
  SummaryId,
  SummaryRevision,
  SummaryRevisionId,
  SummaryInput,
  SummaryChild,
  SummaryChange,
  BackfillApproval,
  BackfillBasis,
  BackfillStatus,
  EnableChoice,
  LcmSettingsInvalid,
  LcmSettingsView
} from "@rp/shared/lcm.ts"
// Storage operations, executed inside the database worker threads (ARCHITECTURE.md §3).
// Each write operation runs as one synchronous transaction inside the writer worker,
// so a transaction can never span an await or a network call.
//
// Every operation on owned data takes the acting user and only touches rows that user
// owns (DATA-MODEL §1, principle 6). Rows owned by someone else are reported as
// NotFound, so their existence doesn't leak.
import { Chat, ChatId, ChatKind, EntityId, NewVersion, PathEntry, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import { ContextIssue, VersionError, VersionStatus } from "@rp/shared/chat.ts"
import {
  Branch,
  ChatCursor,
  ChatSearch,
  DisplayPrefs,
  DisplayPrefsChange,
  NotAmendable,
  PathRange,
  PathWindow
} from "@rp/shared/chatApi.ts"
import { User, UserAccount, UserId, UserRole } from "@rp/shared/domain.ts"
import { BinChanged, BinItem, RecoveredText } from "@rp/shared/bin.ts"
import { Draft, DraftKey, DraftRestore, DraftState } from "@rp/shared/drafts.ts"
import { ComposerChoice } from "@rp/shared/composerApi.ts"
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
import { ChatNotePosition, EditConflict, EditorSnapshot, InvalidDocument, NoteEntry } from "@rp/shared/editorApi.ts"
import { NoteDoc } from "@rp/shared/docs/note.ts"
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
import { GenerationDefaults, GenerationDefaultsChange } from "@rp/shared/generation.ts"
import { NextContext, RunContext } from "@rp/shared/inspectorApi.ts"
import { FoldableEvent, StateEventData } from "@rp/shared/state.ts"
import {
  Cost,
  LlmRequest,
  LlmRequestId,
  CacheStagger,
  RequestPurpose,
  RequestStatus,
  TokenCounts,
  UsageSource
} from "@rp/shared/usage.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { CastCard, ChatSummary, FrozenMacros, QueuedMessage } from "@rp/shared/chat.ts"
import {
  CardForChat,
  CardOverrideOpened,
  CardPromptUse,
  CardUsage,
  ChatCard,
  ChatGroup,
  FirstTurn
} from "@rp/shared/chatSetupApi.ts"
import { AssemblyFailed } from "../assembler/types.ts"

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
  followers: Schema.Array(FollowerMerge),
  /** Drafts a save set aside because what they were in is gone: their text is in the recovered texts. */
  setAside: Schema.optionalKey(Schema.Array(Schema.String)),
  /** How many earlier texts of the committed drafts went to the recovered texts. */
  recovered: Schema.optionalKey(Schema.Int)
}) {}

/** What merging a ref did, and the change that flowed on from it. */
const MergeAndFlow = Schema.Struct({ outcome: MergeOutcome, change: RefChange })

/** A chat's `card.binding` for one card where it's read (the state fold's), null for none. */
const CardBinding = Schema.Struct({ ref: Schema.NullOr(Schema.String), revision: Schema.NullOr(Schema.String) })
/** Every card's binding at a position, by entity id. */
const CardBindings = Schema.Record(Schema.String, CardBinding)

export class DraftTooLarge extends Schema.TaggedError<DraftTooLarge>()("DraftTooLarge", {
  length: Schema.Int,
  max: Schema.Int
}) {}

/**
 * Marks the draft a write took its text from as committed, in the same transaction, so a
 * reload never shows text that was already sent: named by its id, in the session the text
 * was typed in, with exactly that text (drafts.ts `commit`). If it holds anything else now
 * (another tab typed on), it stays active, and nothing else is touched.
 */
const CommitDraft = Schema.NullOr(Schema.Struct({ draftId: Schema.String, session: Schema.Int }))

export class AppendResult extends Schema.Class<AppendResult>("AppendResult")({
  slotId: SlotId,
  version: Version,
  chat: Chat,
  /** The named draft as the write left it: committed, or still active with newer text; null if none was given. */
  draft: Schema.NullOr(Draft),
  /** How many texts committing it sent to the recovered texts (from before destructive or displaced changes). */
  recovered: Schema.Int
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
const ImportedLcmSummary = Schema.Struct({
  noteEntity: Schema.String,
  content: Schema.String,
  firstSlotId: SlotId,
  lastSlotId: SlotId,
  slotCount: Schema.Int,
  hidden: Schema.Int
})

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
  startedAt: Schema.Number,
  reservation: Schema.optionalKey(
    Schema.Struct({ tokens: Schema.Int, cost: Schema.NullOr(Schema.Number), currency: Schema.NullOr(Schema.String) })
  )
})

/** Closes a ledger row with what the request produced. */
const CloseLlmRequest = Schema.Struct({
  cacheIdentity: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        prefixes: Schema.Array(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
        expiresAt: Schema.NullOr(Schema.Number)
      })
    )
  ),
  cacheStagger: Schema.optionalKey(Schema.NullOr(CacheStagger)),
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

// --- ST data folder import (ARCHITECTURE.md §13)
/** The `jobs` kind of an imported chat file's record. */
export const ST_CHAT_RECORD = "st-import-chat"
/** The `jobs` kind of the row naming a user's current import run: the only one that may write. */
export const ST_IMPORT_RUN = "st-import-run"
/** Another import run took the record over, or it finished: this one writes no more of it. */
export class ImportLeaseLost extends Schema.TaggedError<ImportLeaseLost>()("ImportLeaseLost", {
  recordId: Schema.String
}) {}

/** A chat-owned note an ST chat brings, which the writer stores as a note entity. */
export const StImportNote = Schema.Struct({
  kind: Schema.Literals(["author_note", "imported_summary"]),
  title: Schema.String,
  /** Its texts, oldest first, as the note's revisions; the last is current. */
  contents: Schema.NonEmptyArray(Schema.String),
  /** For a summary, the message each text was saved on, in the same order, where it's known. */
  sources: Schema.optionalKey(Schema.Array(Schema.NullOr(SlotId))),
  placement: NoteDoc.fields.placement,
  interval: Schema.optionalKey(Schema.Int),
  template: Schema.optionalKey(Schema.String),
  covers: NoteDoc.fields.covers,
  /** Whether ST sent it: an active note, or one kept for the record. */
  activate: Schema.Boolean
})
export type StImportNote = typeof StImportNote.Type

/** A chat file an earlier import recorded, and the chat it went into. */
const StChatRecord = Schema.Struct({
  recordId: Schema.String,
  source: Schema.String,
  chatId: ChatId,
  complete: Schema.Boolean,
  /** The chat is in the recycle bin. */
  binned: Schema.Boolean,
  /** What the importer last made of the file's chat state (opaque to storage). */
  stateJson: Schema.String,
  /** The chat-owned notes the import made, by kind. */
  notes: Schema.Record(Schema.String, EntityId),
  /** The file's last slot when its import last finished. */
  end: Schema.NullOr(SlotId),
  /** The file went into another file's chat. */
  merged: Schema.Boolean,
  /** The first slot an unfinished import of the file added. */
  firstAdded: Schema.NullOr(SlotId)
})

export class WriteOps extends RpcGroup.make(
  Rpc.make("SetChatPin", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leaf: Schema.NullOr(SlotId),
      pinned: Schema.Boolean,
      forkId: Schema.optional(Schema.String)
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("SetHomePinsCollapsed", {
    payload: { userId: UserId, collapsed: Schema.Boolean },
    success: Schema.Void,
    error: StorageError
  }),
  Rpc.make("SaveLcmMaintenance", {
    payload: { userId: UserId, chatId: ChatId, leafSlotId: SlotId, pins: Schema.String },
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("EnqueueSummaries", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      triggerVersionId: Schema.optionalKey(VersionId),
      chunks: Schema.Array(SummaryChunk),
      requestClass: SummaryJob.fields.requestClass
    },
    success: Schema.Array(SummaryJob),
    error: Schema.Union([StorageError, NotFound])
  }),
  /**
   * Condensations: level n+1 jobs over the ordered parts the planner chose (or an absorbing summary's
   * parts again). Each part is checked to be the chat's, below the level and adjacent to the one
   * before, and the last to lie on the leaf's path; a range a live job covers is skipped.
   */
  Rpc.make("EnqueueCondensations", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      triggerVersionId: Schema.optionalKey(VersionId),
      jobs: Schema.Array(PlannedJob),
      requestClass: SummaryJob.fields.requestClass
    },
    success: Schema.Array(SummaryJob),
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("ReconcileSummaryJobs", {
    payload: { userId: UserId, running: Schema.Array(Schema.Struct({ id: Schema.String, epoch: Schema.Int })) },
    error: StorageError
  }),
  Rpc.make("ClaimSummaryJob", {
    payload: { userId: UserId },
    success: Schema.NullOr(SummaryJob),
    error: StorageError
  }),
  Rpc.make("StartSummaryRollout", {
    payload: {
      userId: UserId,
      jobId: Schema.String,
      attempt: Schema.Int,
      rolloutId: Schema.String,
      snapshot: Schema.String
    },
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("FailSummaryAttempt", {
    payload: {
      userId: UserId,
      jobId: Schema.String,
      attempt: Schema.Int,
      rolloutId: Schema.NullOr(Schema.String),
      draft: Schema.optionalKey(Schema.NullOr(Schema.String)),
      error: Schema.String,
      /** The failure's class (a provider error's reason, `judge`, ...), kept on the job and on the failed summary. */
      errorClass: Schema.optionalKey(Schema.String),
      errorKind: Schema.optionalKey(Schema.Literals(["hard", "soft"])),
      errorCategory: Schema.optionalKey(Schema.NullOr(Schema.String))
    },
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("ReleaseSummaryJob", {
    payload: { userId: UserId, jobId: Schema.String, attempt: Schema.Int },
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("ResetSummaryJobs", {
    success: Schema.Array(Schema.Struct({ userId: UserId, chatId: ChatId, leafSlotId: SlotId })),
    error: StorageError
  }),
  Rpc.make("EscalateSummaryJob", {
    payload: { userId: UserId, jobId: Schema.String },
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("CompleteSummary", {
    payload: {
      userId: UserId,
      jobId: Schema.String,
      rolloutId: Schema.String,
      content: Schema.String,
      status: Schema.Literals(["complete", "truncated"]),
      inputs: Schema.Array(SummaryInput),
      children: Schema.Array(SummaryChild)
    },
    success: Summary,
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("EditSummary", {
    payload: {
      userId: UserId,
      summaryId: SummaryId,
      content: Schema.String,
      expectedRowVersion: Schema.Int,
      commitDraft: CommitDraft
    },
    success: SummaryChange,
    error: Schema.Union([StorageError, NotFound, StaleWrite])
  }),
  Rpc.make("SelectSummaryRevision", {
    payload: { userId: UserId, summaryId: SummaryId, revisionId: SummaryRevisionId, expectedRowVersion: Schema.Int },
    success: Summary,
    error: Schema.Union([StorageError, NotFound, StaleWrite])
  }),
  /** Asks for a summary or a failed job to be done again with the next reply, or withdraws the ask. */
  Rpc.make("SetSummaryRerun", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      target: RerunTarget,
      requested: Schema.Boolean,
      model: Schema.optionalKey(ModelChoice)
    },
    error: Schema.Union([StorageError, NotFound])
  }),
  /**
   * Enables LCM on a chat (spec/LCM.md §2.7): shows the run an imported summary covers and, if
   * `adopt`, records that summary as the first level over it; writes the switch; and, when the
   * work has jobs, records the backfill with the approved spend. Nothing is generated.
   */
  Rpc.make("StageLcmEnable", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      choice: EnableChoice,
      approved: BackfillApproval,
      imported: Schema.NullOr(ImportedLcmSummary),
      runId: Schema.optionalKey(Schema.String)
    },
    success: Schema.Struct({ runId: Schema.String, ready: Schema.Boolean }),
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("EnableLcm", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      choice: EnableChoice,
      approved: BackfillApproval,
      runId: Schema.optionalKey(Schema.String),
      /** Imported summary notes switched on at the leaf: switched off in the same write (an ordinary note switch). */
      switchOff: Schema.optionalKey(Schema.Array(EntityId))
    },
    success: Schema.Struct({ unhidden: Schema.Int, summaryId: Schema.NullOr(Schema.String) }),
    error: Schema.Union([StorageError, NotFound])
  }),
  /**
   * Changes a chat's backfill: pause it; continue past the cap with a new one (`approved` is
   * what is left); `begin` after the first reply planned it; `drive` for "Summarize now"
   * (the work goes on without waiting for replies); `finish` when nothing is left.
   */
  Rpc.make("SetBackfill", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      action: Schema.Literals(["pause", "continue", "begin", "drive", "finish"]),
      approved: Schema.optionalKey(BackfillApproval)
    },
    error: Schema.Union([StorageError, NotFound])
  }),
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
   * it, checking the target belongs to the user; later saves pass the draft as they last
   * saw it, and the writer decides a conflict with another tab (drafts.ts `saveOnto`): a
   * stale tab never overwrites newer text unseen. Every change is kept as an undo history
   * entry (DESIGN §6.2).
   */
  Rpc.make("SaveDraft", {
    payload: {
      userId: UserId,
      key: DraftKey,
      /** The draft the text was typed into, if the client had one: another draft at the key is a conflict. */
      draftId: Schema.NullOr(Schema.String),
      content: Schema.String,
      /** The draft as last seen: null if none was. */
      expectedRowVersion: Schema.NullOr(Schema.Int),
      expectedSession: Schema.NullOr(Schema.Int),
      baseRevision: Schema.NullOr(Schema.String)
    },
    success: Draft,
    error: Schema.Union([NotFound, DraftTooLarge, StorageError])
  }),
  /**
   * The composer at a tip, made empty if there's none, so text typed there has a draft to
   * name. Starting a branch takes the composer along: `copyFrom`'s text is copied in, unless
   * the tip already has text of its own. Switching between existing branches doesn't copy
   * (owner, 2026-10-10).
   */
  Rpc.make("OpenComposer", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      tipSlotId: Schema.NullOr(SlotId),
      copyFrom: Schema.NullOr(Schema.String)
    },
    success: Draft,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Changes a composer draft's speaker or reply choice (null clears one, a missing field
   * stays). Each card named must be one of the user's live cards.
   */
  Rpc.make("SetComposerChoice", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      draftId: Schema.String,
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      replyFromEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      /** Consume a one-reply pick only if it still names this card. */
      consumeReplyFromEntityId: Schema.optionalKey(EntityId)
    },
    success: ComposerChoice,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Composer text onto the draft it was typed into, wherever that draft's tip is now
   * (drafts.ts `saveComposer`): on top of another tab's newer text, or to the recovered
   * texts if the draft's session ended or the draft is gone.
   */
  Rpc.make("SaveComposer", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      draftId: Schema.String,
      rowVersion: Schema.Int,
      session: Schema.Int,
      next: Schema.Boolean,
      operationId: Schema.String,
      content: Schema.String
    },
    success: Schema.Struct({ draft: Schema.NullOr(Draft), recovered: Schema.Boolean }),
    error: Schema.Union([NotFound, DraftTooLarge, StorageError])
  }),
  Rpc.make("RestoreComposer", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      draftId: Schema.String,
      ...DraftRestore
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /** Restores an earlier state from the draft's history. The restore is itself undoable. */
  Rpc.make("RestoreDraftState", {
    payload: { userId: UserId, key: DraftKey, draftId: Schema.String, ...DraftRestore },
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
      draftId: Schema.String,
      outcome: Schema.Literals(["committed", "discarded"]),
      expectedRowVersion: Schema.Int
    },
    success: Draft,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  // --- Recycle bin (DESIGN §6.2). Deletes need no confirmation: each returns the bin
  // item for the "deleted, open the bin" toast, and can be undone from the bin.
  /**
   * Names chats (DESIGN §2.1): each title becomes `renamedTitle(its title, name)`, and the
   * chat's row version moves on. With `from`, a chat is renamed only while its title is
   * still that (a group read before; one renamed meanwhile keeps its name). Returns the
   * chats renamed; NotFound when one isn't the user's live chat.
   */
  Rpc.make("RenameChats", {
    payload: {
      userId: UserId,
      chats: Schema.Array(Schema.Struct({ chatId: ChatId, from: Schema.NullOr(Schema.String) })),
      name: Schema.String
    },
    success: Schema.Array(Chat),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Names the branch a live slot of the user's starts; empty: no name. */
  Rpc.make("SetBranchName", {
    payload: { userId: UserId, slotId: SlotId, name: Schema.String },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
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
    payload: { userId: UserId, itemIds: Schema.Array(Schema.String) },
    success: Schema.Struct({ purged: Schema.Int }),
    error: Schema.Union([BinChanged, StorageError])
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
  /**
   * The chat's own version of a card (DESIGN §4: "only in this chat"): its existing
   * override, or a new one started from the version the chat uses after `slotId`, which
   * `binding` (the chat's `card.binding` there) picks as the context assembler does: a bound
   * revision or ref, else the card's library entry. Where `binding` names another version,
   * the override is bound instead from `slotId` on (a `card.binding` event), so the
   * assembler reads it. Another user's chat, slot or card, or one in the bin, is NotFound.
   */
  Rpc.make("OpenCardOverride", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      slotId: Schema.NullOr(SlotId),
      entityId: EntityId,
      binding: Schema.NullOr(CardBinding)
    },
    success: CardOverrideOpened,
    error: Schema.Union([NotFound, StorageError])
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
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, InvalidDocument, StorageError])
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
    success: Schema.Boolean,
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
   * Hides a live message of the user's from the model, or shows it again (ST's ghost
   * toggle): the slot's `context_excluded`, marked as the user's doing. Writes nothing
   * else but the history reduction a hide records (historyChanges.ts); summaries read
   * visibility when they're checked (lcmReads.ts). `changed`: whether it wasn't so already.
   */
  Rpc.make("SetSlotHidden", {
    payload: { userId: UserId, slotId: SlotId, hidden: Schema.Boolean },
    success: Schema.Struct({ changed: Schema.Boolean }),
    error: Schema.Union([NotFound, StorageError])
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
  /**
   * Several user state changes at one position, in order, as `AddStateEvent` records each, in
   * one transaction: all of them or none (a persona switch, DESIGN §2.2).
   */
  Rpc.make("AddStateEvents", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      slotId: Schema.NullOr(SlotId),
      data: Schema.Array(StateEventData)
    },
    success: Schema.Void,
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
      createdAt: Schema.optionalKey(Schema.Number),
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
    payload: {
      userId: UserId,
      slotId: SlotId,
      version: NewVersion,
      expectedRowVersion: Schema.Int,
      /** For a swipe with a model chosen ("Regenerate with…"): that model, recorded on it at once. */
      model: Schema.optionalKey(ModelChoice),
      /**
       * The draft its text was typed into: an edit's (`version_edit`, its source version) or
       * a version the user wrote (`scratchpad`, the slot), committed with it if it still
       * holds that text.
       */
      commitDraft: Schema.optionalKey(CommitDraft)
    },
    success: Schema.Struct({ chatId: ChatId, version: Version }),
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /** Changes a finished user-written version in place; the trigger keeps the earlier text. */
  Rpc.make("AmendVersion", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      content: Schema.String,
      expectedRowVersion: Schema.Int,
      /** The edit's draft (`version_edit`, this version), committed with it if it still holds that text. */
      commitDraft: Schema.optionalKey(CommitDraft)
    },
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
      /** The reasoning streamed so far; left as it is when absent. */
      reasoning: Schema.optionalKey(Schema.String),
      status: VersionStatus,
      error: Schema.NullOr(VersionError)
    },
    success: Version,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Stars a live version or hides it from the arrows' cycle, or undoes either; one write. */
  Rpc.make("SetVersionFlags", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      starred: Schema.optionalKey(Schema.Boolean),
      hidden: Schema.optionalKey(Schema.Boolean)
    },
    success: Schema.Struct({ chatId: ChatId, version: Version }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A judge model's finding on a finished model version: its text stays (spec/LCM.md §2.4). */
  Rpc.make("MarkVersion", {
    payload: { userId: UserId, versionId: VersionId, mark: Schema.NullOr(Schema.Literals(["refused"])) },
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
      /**
       * Who greets, in order, each as a message of its own (one of `cards`; one without
       * greetings is skipped): the greeting picked, and each greeting's frozen values in
       * `GetCardForChat` order (null: none to freeze).
       */
      greeters: Schema.Array(
        Schema.Struct({
          entityId: EntityId,
          greeting: Schema.NullOr(Schema.Int),
          frozen: Schema.Array(Schema.NullOr(FrozenMacros))
        })
      ),
      first: FirstTurn,
      /** The chat's title; null or blank: its cast's names. */
      title: Schema.NullOr(Schema.String)
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
      /** For a message that's queued: true when it posts without a reply (every character muted). */
      noReply: Schema.optionalKey(Schema.Boolean),
      direction: Schema.NullOr(Schema.String),
      /** The composer the text came from, committed with the post or the queued entry. */
      commitDraft: CommitDraft
    },
    success: Schema.Union([
      Schema.TaggedStruct("Posted", { result: AppendResult }),
      Schema.TaggedStruct("Queued", {
        queued: QueuedMessage,
        queue: Schema.Array(QueuedMessage),
        /** The named draft as the write left it: committed, or still active with newer text; null if none was given. */
        draft: Schema.NullOr(Draft),
        recovered: Schema.Int
      })
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
      /** The reasoning streamed; left as it is when absent. */
      reasoning: Schema.optionalKey(Schema.String),
      status: VersionStatus,
      error: Schema.NullOr(VersionError)
    },
    success: Schema.Struct({ ...QueueOutcome.fields, version: Version }),
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- ST data folder import (ARCHITECTURE.md §13). A chat goes in as a pending chat, its
  // messages in batches of one transaction each, then its state and the chat made active.
  // A record of the file (a `jobs` row) is written with the chat, so a re-run finds it.
  /**
   * A record of an ST chat file under its source path, and a new pending chat for it, unless
   * it goes into `chatId` (a branch file into its parent's chat).
   */
  /**
   * Makes `importId` the user's current import run. Only the current run may claim a record,
   * start a chat or write one: every run before it is over, and the leases it holds expired.
   */
  Rpc.make("StImportSummarySettings", {
    payload: { userId: UserId, importId: Schema.String, prompt: Schema.NullOr(Schema.String), settings: Schema.String },
    success: Schema.Void,
    error: Schema.Union([ImportLeaseLost, StorageError])
  }),
  /** Adopts ST's selected preset only while the user has no stored default. */
  Rpc.make("StImportDefaultPreset", {
    payload: { userId: UserId, importId: Schema.String, refId: RefId },
    success: Schema.Boolean,
    error: Schema.Union([ImportLeaseLost, NotFound, StorageError])
  }),
  Rpc.make("StImportBegin", {
    payload: { userId: UserId, importId: Schema.String },
    success: Schema.Void,
    error: StorageError
  }),
  Rpc.make("StImportStartChat", {
    payload: {
      userId: UserId,
      source: Schema.String,
      title: Schema.String,
      createdAt: Schema.Number,
      chatId: Schema.NullOr(ChatId),
      /** The import run that may write it. */
      lease: Schema.String
    },
    success: Schema.Struct({ chatId: ChatId, recordId: Schema.String }),
    error: Schema.Union([NotFound, ImportLeaseLost, StorageError])
  }),
  /**
   * A batch of messages under `parentSlotId` (null: the chat's first). While `matching`, a
   * message that matches a child already there (a version with the same text, or the text it
   * had before the user amended it, and time, by the same kind of writer) is that child, taking any versions it lacks; the first that
   * doesn't starts new slots. On this file's recorded prior path, position and writer
   * identify a live slot even when ST overwrote its text. Returns each slot, in order.
   */
  Rpc.make("StImportMessages", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      /** The file's record, which keeps the import's progress, and this run's lease of it. */
      recordId: Schema.String,
      lease: Schema.String,
      /** A new chat's leaf follows its messages while they come in. */
      advanceLeaf: Schema.Boolean,
      /**
       * A branch merged into another file's chat: a message matches only where the slot shows
       * the same version and hides it the same way. Otherwise those differences are counted.
       */
      strict: Schema.Boolean,
      parentSlotId: Schema.NullOr(SlotId),
      matching: Schema.Boolean,
      /** A JSON array of the format worker's messages (formats/stChat.ts), passed on unread. */
      messagesJson: Schema.String,
      /** Each speaker key of the messages, as a card of the user's, or null. */
      speakers: Schema.Record(Schema.String, Schema.NullOr(EntityId))
    },
    success: Schema.Struct({
      slotIds: Schema.Array(SlotId),
      matching: Schema.Boolean,
      added: Schema.Int,
      /** Matched slots with added versions or an imported selection change. */
      updated: Schema.Int,
      /** Matched messages shown or hidden differently here than in the file. */
      differing: Schema.Int
    }),
    error: Schema.Union([NotFound, ImportLeaseLost, StorageError])
  }),
  /**
   * The chat's state from the file, at `position` (null: the chat's start), and the chat made
   * active. A new note replaces the import's earlier one of its kind. The leaf moves only if
   * it's still `leaf.from`, so a chat continued here keeps its own leaf.
   */
  Rpc.make("StImportFinishChat", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      recordId: Schema.String,
      lease: Schema.String,
      position: Schema.NullOr(SlotId),
      events: Schema.Array(StateEventData),
      notes: Schema.Array(StImportNote),
      /** The notes of the chat file this one continues (a branch's parent), which new ones replace. */
      previousNotes: Schema.Record(Schema.String, EntityId),
      /** Kinds of note the file no longer has: the import's earlier one is deactivated. */
      removedNotes: Schema.Array(StImportNote.fields.kind),
      /** The chat's new leaf, taken only if the leaf is unset or where this file last ended. */
      leaf: Schema.NullOr(SlotId),
      /** The file's last slot, recorded for the next import. */
      end: Schema.NullOr(SlotId),
      lastMessageAt: Schema.NullOr(Schema.Number),
      sha256: Schema.String,
      stateJson: Schema.String,
      /**
       * A branch's parent and optional ST name. Automatic names still need placement
       * context so local names and explicit clears follow replacement paths.
       */
      fork: Schema.NullOr(Schema.Struct({ name: Schema.NullOr(Schema.String), parentRecordId: Schema.String }))
    },
    success: Schema.Struct({
      notes: Schema.Record(Schema.String, EntityId),
      /** What became of `fork`: set, kept (the slot had a name), or no slot of its own. */
      fork: Schema.NullOr(Schema.Literals(["named", "kept", "same"]))
    }),
    error: Schema.Union([NotFound, ImportLeaseLost, StorageError])
  }),
  /**
   * Makes `lease` (an import run) the one that may write a recorded file's chat: a resumed or
   * repeated import of the file, after which an earlier run's writes are refused. Only the
   * user's current run may claim (`ImportLeaseLost` otherwise); the lease it takes is its
   * own already, or one of a run that's over.
   */
  Rpc.make("StImportClaim", {
    payload: {
      userId: UserId,
      recordId: Schema.String,
      lease: Schema.String,
      /** Resolvable current parent, used to recover legacy placement before matching. */
      parentRecordId: Schema.optionalKey(Schema.String)
    },
    /** The record as it is now, which an earlier view of it may be behind. */
    success: StChatRecord,
    error: Schema.Union([NotFound, ImportLeaseLost, StorageError])
  }),
  /** Un-hides the hidden messages on the path from the chat's first message to `throughSlotId`. */
  Rpc.make("StImportUnhide", {
    payload: { userId: UserId, chatId: ChatId, throughSlotId: SlotId },
    success: Schema.Struct({ unhidden: Schema.Int }),
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- The card and preset editors (editorWrites.ts). Drafts save through SaveDraft.
  /**
   * The ref's head with the named drafts applied, validated against the kind's schema and
   * committed as one revision, the drafts ended with it (@rp/shared/editing.ts).
   */
  Rpc.make("CommitEditorDrafts", {
    payload: {
      chatNote: Schema.optionalKey(ChatNotePosition),
      userId: UserId,
      refId: RefId,
      expectedRowVersion: Schema.Int,
      fields: Schema.Array(
        Schema.Struct({ field: Schema.String, draftId: Schema.String, expectedRowVersion: Schema.Int })
      ),
      message: Schema.NullOr(Schema.String)
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, EditConflict, InvalidDocument, StorageError])
  }),
  /** A new revision on the head with an earlier revision's content. */
  Rpc.make("RestoreRevision", {
    payload: { userId: UserId, refId: RefId, revisionId: RevisionId, expectedRowVersion: Schema.Int },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** ForkRef, optionally moving the ref's unsaved drafts to the new variant. */
  Rpc.make("ForkWithDrafts", {
    payload: {
      userId: UserId,
      refId: RefId,
      label: Schema.String,
      subtitle: Schema.String,
      moveDrafts: Schema.Boolean
    },
    success: LibraryRef,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  Rpc.make("RenameRef", {
    payload: {
      userId: UserId,
      refId: RefId,
      label: Schema.String,
      subtitle: Schema.String,
      expectedRowVersion: Schema.Int
    },
    success: LibraryRef,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  Rpc.make("SetRegexApproval", {
    payload: { userId: UserId, refId: RefId, approved: Schema.Boolean, expectedRowVersion: Schema.Int },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** A new avatar for a card, already written to media storage. */
  Rpc.make("SetCardAvatar", {
    payload: { userId: UserId, refId: RefId, expectedRowVersion: Schema.Int, media: ImportedMedia },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  Rpc.make("CreateCardNote", {
    payload: { userId: UserId, cardRefId: RefId, title: Schema.String },
    success: LibraryRef,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A note of the live chat's own (DESIGN §4.1), an upstream like a card's note. */
  Rpc.make("CreateChatNote", {
    payload: { userId: UserId, chatId: ChatId, title: Schema.String },
    success: LibraryRef,
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- Generation (ARCHITECTURE.md §15).
  /**
   * Opens a generation's rollout before its request is sent (DATA-MODEL §7.1): the row, its
   * frozen context snapshot (JSON text, stored as given), the version's link to it and to
   * the model, the chat variables the preset's and cards' macros wrote, as `var.set`
   * events of the version, and the values its template messages drew. The version must be the user's and still generating, and the
   * model one of the user's live connections'.
   */
  Rpc.make("StartRollout", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      slotId: SlotId,
      versionId: VersionId,
      rolloutId: Schema.String,
      leafSlotId: Schema.NullOr(SlotId),
      connectionId: ConnectionId,
      modelId: ModelId,
      snapshot: Schema.String,
      /** The snapshot's issues, kept on the rollout for its version to show. */
      issues: Schema.Array(ContextIssue),
      variables: Schema.Array(
        Schema.Struct({ name: Schema.String, value: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])) })
      ),
      /**
       * The values template messages of the chat drew, kept with them so they stay the same, and
       * the variables each wrote, recorded at its position the first time it expanded.
       */
      frozenMessages: Schema.Array(
        Schema.Struct({
          versionId: VersionId,
          frozen: Schema.Record(Schema.String, Schema.String),
          variables: Schema.Array(
            Schema.Struct({ name: Schema.String, value: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])) })
          )
        })
      )
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The sanitized SDK payload projection, recorded before HTTP; only the rollout's owner may write it. */
  Rpc.make("RecordSentContext", {
    payload: { userId: UserId, rolloutId: Schema.String, wire: Schema.String },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Closes a rollout with its outcome, and the usage its ledger rows add up to on the rollout
   * and on its version, in one transaction, so both match the ledger (PROVIDERS §9.1).
   */
  Rpc.make("FinishRollout", {
    payload: {
      userId: UserId,
      rolloutId: Schema.String,
      versionId: VersionId,
      status: Schema.Literals(["completed", "stopped", "failed"]),
      error: Schema.NullOr(Schema.String)
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** At startup: rollouts a previous process left running are interrupted. */
  Rpc.make("InterruptRollouts", { success: Schema.Struct({ interrupted: Schema.Int }), error: StorageError }),
  /** The user's default model and preset; NotFound when either isn't the user's and live. */
  Rpc.make("SetGenerationDefaults", {
    payload: { userId: UserId, defaults: GenerationDefaults },
    success: GenerationDefaults,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Marks a lorebook of the user's global (DESIGN §5.0) or not, in `lorebooks.global`;
   * NotFound when it isn't a live library lorebook of the user's. Returns the list as stored.
   */
  Rpc.make("SetGlobalLorebook", {
    payload: { userId: UserId, ref: RefId, global: Schema.Boolean },
    success: Schema.Array(RefId),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A chat's summarization settings changed field by field (DESIGN §8): read and written as a
   * new chat-wide `lcm.settings` event in one transaction; null removes a field.
   */
  Rpc.make("ChangeLcmSettings", {
    payload: { userId: UserId, chatId: ChatId, change: LcmSettingsChange },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError, LcmSettingsInvalid])
  }),
  /** Only the defaults named, merged into the stored ones in the same transaction. */
  Rpc.make("ChangeGenerationDefaults", {
    payload: { userId: UserId, change: GenerationDefaultsChange },
    success: GenerationDefaults,
    error: Schema.Union([NotFound, StorageError, LcmSettingsInvalid])
  }),
  /** The user's display choices, merged in one writer transaction. */
  Rpc.make("SetDisplayPrefs", {
    payload: { userId: UserId, prefs: DisplayPrefsChange },
    success: DisplayPrefs,
    error: StorageError
  }),
  /**
   * Records that a one-time notice was shown for `key` (the impersonation notice: a preset's
   * ref). Answers whether this call recorded it, so of two tabs only one shows it.
   */
  Rpc.make("MarkNoticeShown", {
    payload: { userId: UserId, notice: Schema.Literal("impersonation"), key: Schema.String },
    success: Schema.Boolean,
    error: StorageError
  }),
  // --- Branches (DESIGN §3.2).
  /**
   * Moves the chat's active leaf to one of its live slots, if the chat is still at the row
   * version the caller read the slot at. The composer stays where it was: switching
   * branches carries no text (DESIGN §6.2).
   */
  Rpc.make("SetActiveLeaf", {
    payload: { userId: UserId, chatId: ChatId, slotId: SlotId, expectedRowVersion: Schema.Int },
    success: Chat,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  })
) {}

export class ReadOps extends RpcGroup.make(
  Rpc.make("ShellLibrary", {
    payload: { userId: UserId },
    success: ShellLibrary,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("GetSummary", {
    payload: { userId: UserId, summaryId: SummaryId },
    success: Summary,
    error: Schema.Union([StorageError, NotFound])
  }),
  /** The layer in use on the path to a leaf, with the failed summaries and unfinished jobs on it. */
  Rpc.make("GetLcmState", {
    payload: { userId: UserId, chatId: ChatId, leafSlotId: SlotId },
    success: LcmState,
    error: Schema.Union([StorageError, NotFound])
  }),
  /** Every summary on the path overlapping message depths `fromDepth`..`toDepth`, without their text. */
  Rpc.make("GetLcmCoverage", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      fromDepth: Schema.Int,
      toDepth: Schema.Int,
      includeResolved: Schema.optionalKey(Schema.Boolean)
    },
    success: LcmCoverage,
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("ListSummaryRevisions", {
    payload: { userId: UserId, summaryId: SummaryId },
    success: Schema.Array(SummaryRevision),
    error: Schema.Union([StorageError, NotFound])
  }),
  /** The imported summary a chat could adopt and the work enabling LCM would do, measured (priced by the caller). */
  Rpc.make("ReadLcmImported", {
    payload: { userId: UserId, chatId: ChatId, leafSlotId: SlotId },
    success: Schema.NullOr(ImportedLcmSummary),
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("EstimateBackfill", {
    payload: { userId: UserId, chatId: ChatId, leafSlotId: SlotId },
    success: BackfillBasis,
    error: Schema.Union([StorageError, NotFound])
  }),
  /** The chat's newest backfill and what the ledger shows spent against it; null when it never had one. */
  Rpc.make("GetBackfill", {
    payload: { userId: UserId, chatId: ChatId },
    success: Schema.NullOr(BackfillStatus),
    error: Schema.Union([StorageError, NotFound])
  }),
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
  /**
   * The chat's open message editors: drafts with text of an edit of one of its versions
   * (`version_edit`) or of a version the user is writing of one of its messages (`scratchpad`).
   */
  Rpc.make("ListMessageDrafts", {
    payload: { userId: UserId, chatId: ChatId },
    success: Schema.Array(Draft),
    error: StorageError
  }),
  /** A chat's composer draft's speaker and reply choice, by the draft's id. */
  Rpc.make("GetComposerChoice", {
    payload: { userId: UserId, chatId: ChatId, draftId: Schema.String },
    success: ComposerChoice,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A chat's composer draft's restorable states, by the draft's id. */
  Rpc.make("ComposerHistory", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      draftId: Schema.String,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))
    },
    success: Schema.Array(DraftState),
    error: Schema.Union([NotFound, StorageError])
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
    payload: {
      userId: UserId,
      refId: RefId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.optionalKey(RevisionId)
    },
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
  /**
   * The user's chats, most recent first (DESIGN §2.1: by last message, else creation); a
   * card's, those with a message first. NotFound: the card isn't the user's.
   */
  Rpc.make("ListChats", {
    payload: {
      userId: UserId,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.NullOr(ChatCursor),
      /** Only the chats this card joined. */
      entityId: Schema.optionalKey(EntityId),
      /** Only the chats whose title, or a card in which, has this text. */
      search: Schema.optionalKey(ChatSearch)
    },
    success: Schema.Array(Chat),
    error: Schema.Union([NotFound, StorageError])
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
  /** The user's live character cards (not personas) with their use, in one query (the home grid). */
  Rpc.make("CardUsage", { payload: { userId: UserId }, success: Schema.Array(CardUsage), error: StorageError }),
  /** The user's groups of chats (the home grid), in one read of their chats' casts. */
  Rpc.make("ChatGroups", { payload: { userId: UserId }, success: Schema.Array(ChatGroup), error: StorageError }),
  /** The group `chatId` is in, with its chats, latest message first. */
  Rpc.make("GroupChats", {
    payload: { userId: UserId, chatId: ChatId },
    success: Schema.Struct({ group: ChatGroup, chats: Schema.Array(Chat) }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The chat list's details of these chats, as far as they're the user's; others are left out. */
  Rpc.make("ChatSummaries", {
    payload: { userId: UserId, chatIds: Schema.Array(ChatId) },
    success: Schema.Array(ChatSummary),
    error: StorageError
  }),
  /**
   * These cards, as far as they're the user's (binned ones included); others are left out.
   * With `chat`, each card's name, avatar and lorebook are those of the version the chat
   * uses where `bindings` were folded (`ChatCards`' rules); its label stays the library's.
   */
  Rpc.make("CastCards", {
    payload: {
      userId: UserId,
      entityIds: Schema.Array(EntityId),
      chat: Schema.optionalKey(Schema.Struct({ chatId: ChatId, bindings: CardBindings }))
    },
    success: Schema.Array(CastCard),
    error: StorageError
  }),
  /**
   * These cards as the live chat uses them where `bindings` (the chat's `card.binding`s
   * there) were folded: library entry, its "used by N chats", the chat's override, and the
   * definition the context assembler reads, picked by its rules (assemblySources.ts). A card
   * that isn't the user's live card is NotFound, as a missing one.
   */
  Rpc.make("ChatCards", {
    payload: { userId: UserId, chatId: ChatId, entityIds: Schema.Array(EntityId), bindings: CardBindings },
    success: Schema.Array(ChatCard),
    error: Schema.Union([NotFound, StorageError])
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
  }),
  /**
   * The live chat's own notes, then these cards', by their upstream refs, oldest first; `first`
   * marks each card's first note (ST's Character's Note).
   */
  Rpc.make("ChatNoteEntries", {
    payload: { userId: UserId, chatId: ChatId, slotId: Schema.NullOr(SlotId), cards: Schema.Array(EntityId) },
    success: Schema.Array(
      Schema.Struct({ ref: LibraryRef, doc: Doc, card: Schema.NullOr(EntityId), first: Schema.Boolean })
    ),
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- ST data folder import (ARCHITECTURE.md §13).
  /**
   * What earlier imports made, for a re-run to find: the chat files recorded and the chats
   * they went into, and the user's upstream library refs that came from a file.
   */
  Rpc.make("StImportSources", {
    payload: { userId: UserId },
    success: Schema.Struct({
      chats: Schema.Array(StChatRecord),
      library: Schema.Array(
        Schema.Struct({
          refId: RefId,
          entityId: EntityId,
          kind: EntityKind,
          label: Schema.String,
          sourcePath: Schema.String,
          sourceHash: Schema.NullOr(Schema.String),
          binned: Schema.Boolean
        })
      )
    }),
    error: StorageError
  }),
  // --- The card and preset editors (editorReads.ts).
  Rpc.make("OpenEditor", {
    payload: { userId: UserId, refId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: EditorSnapshot,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A revision of the ref's own entity. */
  Rpc.make("GetRevisionDoc", {
    payload: { userId: UserId, refId: RefId, revisionId: RevisionId },
    success: Doc,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The notes a card owns, by their upstream refs, oldest first. */
  Rpc.make("ListCardNotes", {
    payload: { userId: UserId, cardRefId: RefId },
    success: Schema.Array(NoteEntry),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A stored file the user holds a reference to. */
  Rpc.make("GetMediaFile", {
    payload: { userId: UserId, mediaId: Schema.String },
    success: StoredFile,
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- Context assembly (ARCHITECTURE.md §15).
  /**
   * The context for a version being generated, built by the assembler's stages from this one
   * read transaction: a context snapshot (assembler/types.ts) as JSON text, which the main
   * thread only passes on to be stored, and, apart, what generating needs of it
   * (`Generation` in assembler/types.ts), with what its sources read, pinned. `frozen` passes
   * back the values random and time macros drew.
   */
  Rpc.make("PlanSummaries", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      /** Without one, only new chunks are planned. A reply may start re-summarizing; a finished job only continues it. */
      reason: Schema.optionalKey(Schema.Literals(["reply", "completion"]))
    },
    success: SummaryPlan,
    error: Schema.Union([StorageError, NotFound, AssemblyFailed])
  }),
  Rpc.make("AssembleSummary", {
    payload: { userId: UserId, jobId: Schema.String, attempt: Schema.Int },
    success: Schema.Struct({ snapshot: Schema.String, generation: Schema.String }),
    error: Schema.Union([StorageError, NotFound, AssemblyFailed])
  }),
  Rpc.make("AssembleContext", {
    payload: {
      partialBatch: Schema.optionalKey(Schema.Boolean),
      /** "Retry with…": this model instead of the chat's. */
      model: Schema.optionalKey(ModelChoice),
      userId: UserId,
      chatId: ChatId,
      slotId: SlotId,
      versionId: VersionId,
      now: Schema.Number,
      timeZone: Schema.String,
      frozen: Schema.NullOr(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)))
    },
    success: Schema.Struct({ snapshot: Schema.String, generation: Schema.String }),
    error: Schema.Union([NotFound, AssemblyFailed, StorageError])
  }),
  /**
   * A context built again from a snapshot taken before, reading what its sources pinned
   * (`SourcePins` in assembler/types.ts) rather than the chat as it is now (invariant 6).
   */
  Rpc.make("RebuildContext", {
    payload: { userId: UserId, snapshot: Schema.String },
    success: Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("Rebuilt"), snapshot: Schema.String }),
      Schema.Struct({
        _tag: Schema.Literal("EarlierAssemblerVersion"),
        assemblerVersion: Schema.Int,
        currentVersion: Schema.Int,
        storedSnapshot: Schema.String
      })
    ]),
    error: Schema.Union([NotFound, AssemblyFailed, StorageError])
  }),
  /** A version's context as it was sent, with its sources named and its usage (inspectorReads.ts). */
  Rpc.make("RunContext", {
    payload: { userId: UserId, versionId: VersionId },
    success: RunContext,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Whether a prior request covers the entire requested provider cache endpoint. */
  Rpc.make("CachePrefixWarm", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      modelId: ModelId,
      prefix: Sha256,
      now: Schema.Number
    },
    success: Schema.Boolean,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A chat's summarization settings, resolved and fitted to the next context at the leaf. */
  Rpc.make("LcmSettingsAt", {
    payload: { userId: UserId, chatId: ChatId, leafSlotId: Schema.NullOr(SlotId) },
    success: LcmSettingsView,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("CacheWarmth", {
    payload: { userId: UserId, chatId: ChatId, leafSlotId: Schema.optionalKey(Schema.NullOr(SlotId)) },
    success: NextContext,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The user's generation defaults; one naming something gone reads as none. */
  Rpc.make("GetGenerationDefaults", {
    payload: { userId: UserId },
    success: GenerationDefaults,
    error: StorageError
  }),
  /** The user's global lorebooks: live library lorebooks of theirs, in the order marked. */
  Rpc.make("GetGlobalLorebooks", { payload: { userId: UserId }, success: Schema.Array(RefId), error: StorageError }),
  /** What the preset the user's chats use does with a card's own prompts (DESIGN §5.0). */
  Rpc.make("GetCardPromptUse", { payload: { userId: UserId }, success: CardPromptUse, error: StorageError }),
  /** The user's display choices; the defaults where none are stored. */
  Rpc.make("GetDisplayPrefs", { payload: { userId: UserId }, success: DisplayPrefs, error: StorageError }),
  // --- Branches (DESIGN §3.2).
  /**
   * Where switching to the branch at `index` among `slotId`'s alternates leads: that
   * sibling, the tip below it on its newest replies (as ReadPath's Around opens it), and
   * the chat's row version, for SetActiveLeaf.
   */
  Rpc.make("BranchTip", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      slotId: SlotId,
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    },
    success: Schema.Struct({ slotId: SlotId, tipSlotId: SlotId, chatRowVersion: Schema.Int }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The alternates at a live slot's place, as BranchTip counts them, oldest first, with names. */
  Rpc.make("ListBranches", {
    payload: { userId: UserId, slotId: SlotId },
    success: Schema.Array(Branch),
    error: Schema.Union([NotFound, StorageError])
  })
) {}
