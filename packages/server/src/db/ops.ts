import { ArchiveCriteria, ArchiveCandidate, CardArchiveReceipt } from "@rp/shared/cardArchive.ts"
import { SetSplitChatFields, SplitChats } from "@rp/shared/splitChat.ts"
import { EditRefused } from "@rp/shared/editorApi.ts"
import { AssetChange, CardGallery } from "@rp/shared/gallery.ts"
import { ForkMergePreview, MergeSelection, MergeStatus, LibraryGenealogy } from "@rp/shared/forkMerge.ts"
import { StArrival } from "@rp/shared/stImportApi.ts"
import { ReplySections } from "@rp/shared/replySections.ts"
import { BinLimits, BinLimitChange } from "@rp/shared/bin.ts"
import { CostSettings, CostRules } from "@rp/shared/costFormulas.ts"
import { Snippet, SnippetContext, CreateSnippetFields, SnippetScopeFields } from "@rp/shared/snippetsApi.ts"
import { historyReadRpcs, historyWriteRpcs, HistoryRejected } from "@rp/shared/historyApi.ts"
import { InsertBody, InsertRefused } from "@rp/shared/messagesApi.ts"
import {
  MergeChanged,
  MergeChatInput,
  MergedMessage,
  MergeInfo,
  ChatMergePreview,
  MergeRefused,
  MergeRequest
} from "@rp/shared/mergeApi.ts"
import { PlannedJob, SummaryJob, SummaryChunk, SummaryPlan } from "./lcmJobs.ts"
import { AwayMark } from "@rp/shared/contextsApi.ts"
import { RoleProjectionOption, ShellCards, ShellForks, ShellForksView, ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import { LcmSettingsChange, ModelChoice } from "@rp/shared/lcmSettings.ts"
import {
  LcmCoverage,
  LcmState,
  RerunTarget,
  Summary,
  SummaryDetails,
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
import {
  Chat,
  ChatId,
  ChatKind,
  EntityId,
  Fork,
  ForkId,
  MessageImages,
  NewVersion,
  PathEntry,
  SlotId,
  Version,
  VersionId
} from "@rp/shared/chat.ts"
import { ContextIssue, VersionError, VersionStatus } from "@rp/shared/chat.ts"
import { RecentRemote, SourcePrefs } from "@rp/shared/cardSources.ts"
import {
  ForkNote,
  ForkNoteSelection,
  ForkNotesChanged,
  VersionAmendment,
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
import { BinBranch, BinChanged, BinForkShown, BinItem, CannotDeleteLastFork, RecoveredText } from "@rp/shared/bin.ts"
import {
  EditingOrigin,
  ObservedDeletion,
  Draft,
  DraftHistoryPolicy,
  DraftKey,
  DraftRestore,
  DraftState
} from "@rp/shared/drafts.ts"
import {
  ComposerImage,
  ComposerImageIds,
  ComposerImageKey,
  SetComposerImageFields,
  ComposerChoice
} from "@rp/shared/composerApi.ts"
import { AccountRejected, LeafMoved, ModelKeyTaken, NotFound, StaleWrite } from "@rp/shared/errors.ts"
import { StImportJob } from "@rp/shared/stImportApi.ts"
import {
  CardFamily,
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
import { CardReplaceSource } from "@rp/shared/cardReplace.ts"
import {
  ChatNotePosition,
  EditConflict,
  EditorSnapshot,
  InvalidDocument,
  NoteEntry,
  SharedNote
} from "@rp/shared/editorApi.ts"
import { NoteDoc, ReplaceTarget } from "@rp/shared/docs/note.ts"
import {
  Connection,
  ConnectionId,
  ConnectionSettings,
  Credential,
  CredentialId,
  Model,
  ModelEndpoints,
  ModelId,
  ModelOverrides,
  ModelUse,
  ModelUpstream,
  ProviderKind,
  ProxyMode
} from "@rp/shared/providers.ts"
import { GenerationDefaults, GenerationDefaultsChange, TokenCountingChoice } from "@rp/shared/generation.ts"
import { NextContext, RunContext, VersionMetrics } from "@rp/shared/inspectorApi.ts"
import { ActivityCursor, ActivityPage, NotResumable, RolloutStep, RunTranscript } from "@rp/shared/agent.ts"
import { GlobalRegex, GlobalScripts, RawText, StoredRewrite, TextRewrite } from "@rp/shared/regexScripts.ts"
import { FoldableEvent, StateEventData, StoredStateEventData } from "@rp/shared/state.ts"
import { ConnectionDecisions, DecisionPointSetting } from "@rp/shared/decisions.ts"
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
import { AvatarCrop } from "@rp/shared/media.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { CastCard, ChatSummary, FrozenMacros, QueuedMessage } from "@rp/shared/chat.ts"
import {
  CardForChat,
  CardPromptUse,
  CardUsage,
  ChatCard,
  ChatGroup,
  FirstTurn,
  LinkedNote,
  LorebookPreset
} from "@rp/shared/chatSetupApi.ts"
import { AssemblyFailed } from "../assembler/types.ts"

const StorageErrorReason = Schema.Literals(["busy", "constraint", "corrupt", "other"])

/** A library entry an assembly read: its entity, the ref (null: the entity's upstream) and the revision read. */
export const UsedEntry = Schema.Struct({
  entity: Schema.String,
  ref: Schema.NullOr(Schema.String),
  revision: Schema.String
})
export type UsedEntry = typeof UsedEntry.Type

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

/** The operation doesn't apply to this kind of ref (e.g. ForkRef on a card, which forks with its names). */
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
  recovered: Schema.optionalKey(Schema.Int),
  /** The fields those texts came from. */
  recoveredFields: Schema.optionalKey(Schema.Array(Schema.String))
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
  /** The fork it went to: the one named, or one made for it (`branch`). */
  forkId: ForkId,
  version: Version,
  chat: Chat,
  /** The named draft as the write left it: committed, or still active with newer text; null if none was given. */
  draft: Schema.NullOr(Draft),
  /** How many texts committing it sent to the recovered texts (from before destructive or displaced changes). */
  recovered: Schema.Int
}) {}

/** The inserted message as its fork shows it, at its position on the fork's display path. */
/** A merge's join message (spec/CHAT-MERGE.md §8): where its fork shows it, and the chat. */
export class MergeResult extends Schema.Class<MergeResult>("MergeResult")({
  slotId: SlotId,
  forkId: ForkId,
  position: Schema.Int,
  chat: Chat
}) {}

export class InsertResult extends Schema.Class<InsertResult>("InsertResult")({
  slotId: SlotId,
  forkId: ForkId,
  position: Schema.Int,
  version: Version,
  chat: Chat
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
  summaryResponse: Schema.optionalKey(Schema.String),
  textEstimate: Schema.optionalKey(Schema.Struct({ tokens: Schema.Int, tokenizer: Schema.String })),
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

/** A reply the send queue posted, generating, for the caller to start in its fork. */
const QueuedReply = Schema.Struct({ slotId: SlotId, versionId: VersionId, forkId: Schema.optionalKey(ForkId) })

/** What the send queue did behind a slot (chatSetupWrites.ts). */
export const QueueOutcome = Schema.Struct({
  chatId: ChatId,
  /** Slots the queue posted, in order, the next reply's last. */
  posted: Schema.Array(SlotId),
  next: Schema.NullOr(QueuedReply),
  /** Replies posted in other forks' queues behind the same slot, each to start as `next` does. */
  more: Schema.optionalKey(Schema.Array(QueuedReply)),
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
  /** A card's other notes (exportable or not: the format worker leaves the private ones out). */
  notesDocJson: Schema.Array(Schema.String),
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
  /** Which of the chat file's notes it is, by which a re-import finds it; only a summary's doc keeps it. */
  kind: Schema.Literals(["author_note", "imported_summary"]),
  title: Schema.String,
  /** Its texts, oldest first, as the note's revisions; the last is current. */
  contents: Schema.NonEmptyArray(Schema.String),
  /** Source file time; summary revisions prefer their individual source messages. */
  modifiedAt: Schema.optionalKey(Schema.Number),
  /** For a summary, the message each text was saved on, in the same order, where it's known. */
  sources: Schema.optionalKey(Schema.Array(Schema.NullOr(SlotId))),
  placement: NoteDoc.fields.placement,
  /** Lorebook entries can trigger on it (ST's `allowWIScan`). */
  scanLore: Schema.optionalKey(Schema.Boolean),
  template: Schema.optionalKey(Schema.String),
  covers: NoteDoc.fields.covers,
  /** Whether ST sent it: an active note, or one kept for the record. */
  activate: Schema.Boolean
})
export type StImportNote = typeof StImportNote.Type

/** A chat file an earlier import recorded, and the chat it went into. */
const StChatRecord = Schema.Struct({
  forkId: ForkId,
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

/**
 * A chat's fork summaries (db/forkSummaries.ts), computed by a read at the stamps it read, for
 * `StoreForkSummaries`. `forks` is their JSON, as the writer stores it: decoding thousands of
 * them on the main thread only to encode them again cost as much as the read.
 */
const ChatSummariesAt = Schema.Struct({
  chatId: Schema.String,
  stamp: Schema.Int,
  userStamp: Schema.Int,
  forks: Schema.String
})

/** `ShellLibrary` and the summaries the read had to compute, which the caller stores (never sent to the client). */
export const ShellLibraryRead = Schema.Struct({ ...ShellLibrary.fields, fresh: Schema.Array(ChatSummariesAt) })
/** `ShellCards` and `ShellForks` with the summaries the read computed, as `ShellLibraryRead`. */
const ShellCardsRead = Schema.Struct({ ...ShellCards.fields, fresh: Schema.Array(ChatSummariesAt) })
const ShellForksRead = Schema.Struct({ ...ShellForks.fields, fresh: Schema.Array(ChatSummariesAt) })

/** A source's card as `AdoptRemoteCard` adds it (spec/CARD-SOURCES.md §4.5). */
const AdoptFields = {
  userId: UserId,
  sourceId: Schema.String,
  remoteId: Schema.String,
  /** The source's version id, and the SHA-256 of the file as the source gave it. */
  remoteVersion: Schema.String,
  file: Schema.Struct({
    label: Schema.String,
    docJson: Schema.String,
    docHash: Schema.String,
    searchText: Schema.String,
    schemaVersion: Schema.Int,
    sourceName: Schema.String,
    sourceHash: Sha256,
    media: Schema.Array(ImportedMedia),
    noteDocJson: Schema.NullOr(Schema.String),
    notesDocJson: Schema.optionalKey(Schema.Array(Schema.String)),
    characterNoteScan: Schema.optionalKey(Schema.Boolean)
  })
}

/** A chat made from cards on its first turn, as `StartChat` takes it. */
const StartChatFields = {
  guidance: Schema.optionalKey(Schema.Boolean),
  userId: UserId,
  cards: Schema.Array(EntityId),
  persona: Schema.NullOr(EntityId),
  /**
   * Who greets, in order, each as a message of its own (one of `cards`; one without
   * greetings is skipped): the greeting picked and the API's registered-source
   * snapshot, with each option's nonempty card index, text and frozen values.
   */
  greeters: Schema.Array(
    Schema.Struct({
      entityId: EntityId,
      greeting: Schema.NullOr(Schema.Int),
      options: Schema.Array(
        Schema.Struct({
          index: Schema.Int,
          text: Schema.String,
          frozen: Schema.NullOr(FrozenMacros)
        })
      )
    })
  ),
  first: FirstTurn,
  /** The chat's title; null or blank: its cast's names. */
  title: Schema.NullOr(Schema.String)
}

export const StartChatResult = Schema.Struct({ ...AppendResult.fields, composer: Draft })

export class WriteOps extends RpcGroup.make(
  /**
   * Merges another chat's fork into `forkId` below `at` (spec/CHAT-MERGE.md §8): recomputes the
   * preview and refuses with the new one when its digest changed (`MergeChanged`), then writes
   * the join message (appended at the fork's tip, else inserted), the merge's rows, the cast
   * union's joins, and chats in the fork. One transaction.
   */
  Rpc.make("MergeChat", {
    payload: { userId: UserId, ...MergeChatInput.fields },
    success: MergeResult,
    error: Schema.Union([NotFound, StaleWrite, MergeRefused, MergeChanged, StorageError])
  }),
  Rpc.make("DeleteChatGroup", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: ForkId,
      expectedForkIds: Schema.Array(ForkId),
      title: Schema.String
    },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError, BinChanged])
  }),
  Rpc.make("SetSplitChat", {
    payload: { userId: UserId, ...SetSplitChatFields },
    success: ChatId,
    error: Schema.Union([NotFound, StorageError, EditRefused])
  }),
  Rpc.make("ChangeBinLimit", {
    payload: { userId: UserId, ...BinLimitChange.fields },
    success: BinLimits,
    error: StorageError
  }),
  Rpc.make("SetCostSettings", {
    payload: { userId: UserId, expectedRevision: Schema.Int, rules: CostRules },
    success: CostSettings,
    error: Schema.Union([StaleWrite, NotFound, StorageError])
  }),
  Rpc.make("CreateSnippet", {
    payload: { userId: UserId, ...CreateSnippetFields },
    success: Snippet,
    error: Schema.Union([NotFound, DraftTooLarge, StorageError])
  }),
  /** A snippet for all chats, or only the chat shown; narrowing one shown elsewhere is refused. */
  Rpc.make("SetSnippetScope", {
    payload: { userId: UserId, ...SnippetScopeFields },
    success: Snippet,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  historyWriteRpcs[0]
    .setPayload(Schema.Struct({ ...historyWriteRpcs[0].payloadSchema.fields, userId: UserId }))
    .setError(Schema.Union([NotFound, HistoryRejected, StorageError])),
  historyWriteRpcs[1]
    .setPayload(Schema.Struct({ ...historyWriteRpcs[1].payloadSchema.fields, userId: UserId }))
    .setError(Schema.Union([NotFound, HistoryRejected, StorageError])),
  /** Pins the owned chat globally. Legacy leaf/forkId are ignored. */
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
  /** A live card of the user's marked a favourite or not (db/cardFavourites.ts); NotFound otherwise. */
  Rpc.make("SetCardFavourite", {
    payload: { userId: UserId, entityId: EntityId, favourite: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Each chat's summaries, if the chat's and its owner's stamps are still the ones they were computed at. */
  Rpc.make("StoreForkSummaries", {
    payload: { userId: UserId, chats: Schema.Array(ChatSummariesAt) },
    success: Schema.Void,
    error: StorageError
  }),
  Rpc.make("SaveLcmMaintenance", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      pins: Schema.String
    },
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("EnqueueSummaries", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      /** The fork it plans in (absent or null: the fork through the leaf, the current one first). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
      /** The fork it plans in (absent or null: the fork through the leaf, the current one first). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
    success: Schema.Array(
      Schema.Struct({ userId: UserId, chatId: ChatId, forkId: Schema.NullOr(ForkId), leafSlotId: SlotId })
    ),
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      userId: UserId,
      summaryId: SummaryId,
      revisionId: SummaryRevisionId,
      expectedRowVersion: Schema.Int
    },
    success: Summary,
    error: Schema.Union([StorageError, NotFound, StaleWrite])
  }),
  /** Asks for a summary or a failed job to be done again with the next reply, or withdraws the ask. */
  Rpc.make("SetSummaryRerun", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
      seed: Schema.optionalKey(Schema.Boolean),
      editingFrom: Schema.optionalKey(EditingOrigin),
      observedDeletion: Schema.optionalKey(ObservedDeletion),
      images: Schema.optionalKey(MessageImages),
      /** The draft as last seen: null if none was. */
      expectedRowVersion: Schema.NullOr(Schema.Int),
      expectedSession: Schema.NullOr(Schema.Int),
      baseRevision: Schema.NullOr(Schema.String)
    },
    success: Draft,
    error: Schema.Union([NotFound, DraftTooLarge, StorageError])
  }),
  /**
   * The composer of a fork (null: the chat's current one), made empty if there's none, so
   * text typed there has a draft to name. Starting a branch takes the composer along:
   * `copyFrom`'s text is copied in, unless the fork already has text of its own. Switching
   * between existing branches doesn't copy (owner, 2026-10-10).
   */
  Rpc.make("OpenComposer", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.NullOr(ForkId),
      copyFrom: Schema.NullOr(Schema.String)
    },
    success: Draft,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Changes a composer draft's speaker or reply choice (null clears one, a missing field
   * stays). Each card named must be one of the user's live cards.
   */
  Rpc.make("SetComposerImage", {
    payload: { userId: UserId, ...SetComposerImageFields },
    success: ComposerImage,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("SetComposerChoice", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      draftId: Schema.String,
      guidance: Schema.optionalKey(Schema.Boolean),
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      replyFromEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      noReplies: Schema.optionalKey(Schema.Boolean),
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
  /**
   * Names a live fork of the user's; empty: no name. Its first message (`startSlotId`, null
   * when it has none of its own), which shows the name among its alternates, gets a new row
   * version, so open tabs take the name.
   */
  Rpc.make("SetForkName", {
    payload: { userId: UserId, forkId: ForkId, name: Schema.String },
    success: Schema.Struct({ fork: Fork, startSlotId: Schema.NullOr(SlotId) }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Pins a live fork within its chat only, independently of the global chat pin. */
  Rpc.make("SetForkPinned", {
    payload: { userId: UserId, forkId: ForkId, pinned: Schema.Boolean },
    success: Fork,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A fork of `fromForkId` (null: the current one) at `atSlotId`, a message on its path
   * (null: before the first): its history is the path to there, and it becomes the chat's
   * current fork (spec/FORK-INDEPENDENCE-DELTA.md §2.1).
   */
  Rpc.make("CreateFork", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      fromForkId: Schema.NullOr(ForkId),
      atSlotId: Schema.NullOr(SlotId),
      notes: Schema.optionalKey(ForkNoteSelection),
      name: Schema.optionalKey(Schema.String)
    },
    success: Schema.Struct({ fork: Fork, chat: Chat }),
    error: Schema.Union([NotFound, StorageError, ForkNotesChanged])
  }),
  Rpc.make("DeleteChat", {
    payload: { userId: UserId, chatId: ChatId },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Deletes one message in a fork (`forkId`, else the fork through it): the other forks that
   * show it keep it. Its replies stay.
   */
  Rpc.make("DeleteMessage", {
    payload: { userId: UserId, slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
    success: BinItem,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Deletes one fork (owner, 2026-10-27): only that fork goes, and forks made from it keep
   * their shared history. A chat's last live fork can't be deleted (`CannotDeleteLastFork`).
   */
  Rpc.make("DeleteFork", {
    payload: { userId: UserId, forkId: ForkId },
    success: BinItem,
    error: Schema.Union([NotFound, CannotDeleteLastFork, StorageError])
  }),
  /**
   * Deletes one swipe: the normal delete (owner, 2026-10-10). If it was showing, the
   * previous swipe shows. A message's only remaining version takes the message with it.
   */
  Rpc.make("DeleteVersion", {
    payload: { userId: UserId, versionId: VersionId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
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
    payload: {
      userId: UserId,
      itemId: Schema.String,
      expectedForkIds: Schema.optionalKey(Schema.Array(Schema.String))
    },
    success: Schema.Array(Schema.String),
    error: Schema.Union([NotFound, BinChanged, StorageError])
  }),
  Rpc.make("EmptyBin", {
    payload: {
      userId: UserId,
      itemIds: Schema.Array(Schema.String),
      expectedForkIds: Schema.optionalKey(Schema.Array(Schema.String))
    },
    success: Schema.Struct({ purged: Schema.Int, chatIds: Schema.Array(Schema.String) }),
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
      sourcePath: Schema.NullOr(Schema.String),
      tags: Schema.optionalKey(Schema.Array(Schema.String))
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
  Rpc.make("ArchiveUnusedCards", {
    payload: { userId: UserId, criteria: ArchiveCriteria, entityIds: Schema.Array(EntityId) },
    success: CardArchiveReceipt,
    error: StorageError
  }),
  Rpc.make("UndoCardArchive", {
    payload: { userId: UserId, ...CardArchiveReceipt.fields },
    success: Schema.Int,
    error: StorageError
  }),
  Rpc.make("SetEntityArchived", {
    payload: { userId: UserId, entityId: EntityId, archived: Schema.Boolean },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Archives or restores a library entry (a fork is an entry of its own, so its parent and
   * siblings stay as they are): hidden from lists, nothing deleted, in use where it is used.
   * Archiving keeps the first time it was archived.
   */
  Rpc.make("SetRefArchived", {
    payload: { userId: UserId, refId: RefId, archived: Schema.Boolean },
    success: LibraryRef,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /**
   * A fork of a preset, lorebook or note (spec/LIBRARY-FORKS.md): a new entry of the same kind
   * from `refId`'s head, tied to it only by its lineage; cards fork with ForkCard.
   */
  Rpc.make("ForkRef", {
    payload: { userId: UserId, refId: RefId, label: Schema.String, subtitle: Schema.String },
    success: LibraryRef,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  Rpc.make("CommitForkMerge", {
    payload: {
      userId: UserId,
      refId: RefId,
      theirsRevisionId: RevisionId,
      baseRevisionId: Schema.NullOr(RevisionId),
      expectedRowVersion: Schema.Int,
      selection: MergeSelection,
      message: Schema.NullOr(Schema.String)
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, InvalidDocument, StorageError])
  }),
  Rpc.make("UndoForkMerge", {
    payload: { userId: UserId, refId: RefId, mergeRevisionId: RevisionId, expectedRowVersion: Schema.Int },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** Merges in what the ref follows, if it can be done without conflicts. */
  Rpc.make("MergeFollowed", {
    payload: { userId: UserId, refId: RefId },
    success: MergeAndFlow,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
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
      /** The provider chosen (providerDefinitions.ts); left out, the kind's default provider. */
      provider: Schema.optionalKey(Schema.String),
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
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      key: Schema.String,
      overrides: ModelOverrides,
      /** What a catalog knows of the id; a refresh rewrites it like any upstream. */
      upstream: Schema.optionalKey(ModelUpstream)
    },
    success: Model,
    error: Schema.Union([NotFound, ModelKeyTaken, StorageError])
  }),
  /** Replaces the user's edits to a model. */
  Rpc.make("EditModel", {
    payload: { userId: UserId, modelId: ModelId, overrides: ModelOverrides, expectedRowVersion: Schema.Int },
    success: Model,
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /** Sets or clears the context size learned from a provider's error, keeping the user's other edits. */
  Rpc.make("SetLearnedContext", {
    payload: { userId: UserId, modelId: ModelId, context: Schema.NullOr(Schema.Int), at: Schema.Number },
    success: Model,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Stores the endpoint list fetched for a model (a price per provider), replacing an older one. */
  Rpc.make("SetModelEndpoints", {
    payload: { userId: UserId, modelId: ModelId, endpoints: ModelEndpoints },
    success: Model,
    error: Schema.Union([NotFound, StorageError])
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
  /** A provider's exact count of one image for one model (ARCHITECTURE §6, image tokens). */
  Rpc.make("RecordImageTokenCount", {
    payload: {
      userId: UserId,
      sha256: Sha256,
      kind: Schema.String,
      modelKey: Schema.String,
      detail: Schema.String,
      tokens: Schema.Int
    },
    success: Schema.Void,
    error: StorageError
  }),
  /** What a request's images cost together, for models without a formula; keeps the newest 20. */
  Rpc.make("RecordImageTokenSample", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      modelKey: Schema.String,
      images: Schema.Int,
      pixels: Schema.Int,
      tokens: Schema.Int,
      source: Schema.Literals(["reported", "derived"])
    },
    success: Schema.Void,
    error: StorageError
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
   * Adds a slot under `parentSlotId` (null: a root) in fork `forkId` (absent or null: the
   * current one) and makes it the fork's tip; the fork becomes current. The first message
   * turns a pending chat active.
   *
   * A branch is explicit (DESIGN §3.2): without `branch`, the parent must be the fork's
   * tip, so a tab that missed a newer message gets LeafMoved (with the tip) instead of
   * silently forking the conversation. With it, a new fork is made at the parent.
   */
  Rpc.make("AppendMessage", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      parentSlotId: Schema.NullOr(SlotId),
      branch: Schema.Boolean,
      version: NewVersion,
      commitDraft: CommitDraft
    },
    success: AppendResult,
    error: Schema.Union([NotFound, LeafMoved, StorageError])
  }),
  /**
   * A message inserted below `anchorSlotId` (null: above the first message) in fork `forkId`
   * (spec/MESSAGE-INSERT.md §2.4, §7): a new slot marked inserted, its first version and an
   * `insert` row placing it in that fork, which forks made from it later inherit. The anchor
   * must be on the fork's display path and not deleted there (`StaleWrite`); a neighbour
   * inserted since is no conflict. `expectedRowVersion` is the anchor's as the tab saw the fork
   * show it, reported back in the refusal. The fork is chatted in. A `Generate` body writes a
   * model version still generating, which the caller then starts, as for a swipe.
   */
  Rpc.make("InsertMessage", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: ForkId,
      anchorSlotId: Schema.NullOr(SlotId),
      expectedRowVersion: Schema.Int,
      body: InsertBody
    },
    success: InsertResult,
    error: Schema.Union([NotFound, StaleWrite, InsertRefused, StorageError])
  }),
  /**
   * A new version in place: a swipe, an edit, or "write your own" (DESIGN §3.1). An
   * edit's `sourceVersionId` is a live version of the same slot. A new slot's first
   * version has no source.
   */
  Rpc.make("AddVersion", {
    payload: {
      userId: UserId,
      slotId: SlotId,
      /** The fork it's added in, which `select` selects it in (absent or null: the current one). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      version: NewVersion,
      select: Schema.Boolean,
      commitDraft: CommitDraft
    },
    success: Version,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Changes which version a slot shows in a fork (absent or null: the current one), if it
   * still shows `expectedVersionId` there. Never touches any other slot (invariant 3) or
   * fork (spec/FORK-INDEPENDENCE-DELTA.md §2.2).
   */
  Rpc.make("SelectVersion", {
    payload: {
      userId: UserId,
      slotId: SlotId,
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedVersionId: VersionId
    },
    success: Schema.Struct({ forkId: ForkId }),
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /**
   * Hides a live message of the user's from the model, or shows it again (ST's ghost
   * toggle): the slot's `context_excluded`, marked as the user's doing. Writes nothing
   * else but the history reduction a hide records (historyChanges.ts); summaries read
   * visibility when they're checked (lcmReads.ts). `changed`: whether it wasn't so already.
   */
  Rpc.make("SetSlotHidden", {
    payload: {
      userId: UserId,
      slotId: SlotId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      hidden: Schema.Boolean
    },
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: Schema.NullOr(SlotId),
      /** Composer write: resolve a structural tip to its display end in this transaction. */
      displayEnd: Schema.optionalKey(Schema.Boolean),
      versionId: Schema.NullOr(VersionId),
      scope: FoldableEvent.fields.scope,
      data: StoredStateEventData
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: Schema.NullOr(SlotId),
      /** Composer write: resolve a structural tip to its display end in this transaction. */
      displayEnd: Schema.optionalKey(Schema.Boolean),
      data: Schema.Array(StoredStateEventData)
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
      /** Full-folder arrival evidence; ordinary single-file uploads omit it. */
      arrival: Schema.optionalKey(StArrival),
      /** Source modification time for an ST folder import; absent for ordinary uploads. */
      modifiedAt: Schema.optionalKey(Schema.Number),
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
      noteDocJson: Schema.NullOr(Schema.String),
      /** The card's other notes, without their owner, each matched to an earlier import's by `module_id`. */
      notesDocJson: Schema.optionalKey(Schema.Array(Schema.String)),
      /** ST scans its notes for lorebook entries (`allowWIScan`): so does the card's Character's Note. */
      characterNoteScan: Schema.optionalKey(Schema.Boolean),
      /**
       * A preset's lorebooks (`PresetDoc.lorebooks`), each on, from an ST folder's global World
       * Info books (§13); ids that aren't the user's live library lorebooks are left out.
       */
      presetLorebooks: Schema.optionalKey(Schema.Array(RefId)),
      /**
       * "Import a new version…" of a card (§11.1): the file goes on the import line, and the
       * card's next revision is the file's content wholesale (`replacementDoc`), not a merge,
       * its merge base that import. Refused unless the head is still the one previewed. The
       * card's notes and favourite stay as they are.
       */
      stageMerge: Schema.optionalKey(Schema.Boolean),
      replace: Schema.optionalKey(Schema.Struct({ expectedHeadRevisionId: Schema.String }))
    },
    success: LibraryImport,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /**
   * A card from a card source into the library (spec/CARD-SOURCES.md §4.5), in one
   * transaction: what `ImportFile` stores for a new card file, then its `card_origins` row.
   * A card the user already has from there (a live card, archived or not) is answered
   * instead, with `existing`, so it's never added twice; an origin whose card is in the bin
   * or purged is let go, and the card is added again.
   */
  Rpc.make("AdoptRemoteCard", {
    payload: AdoptFields,
    success: Schema.Struct({ entityId: EntityId, refId: RefId, existing: Schema.Boolean }),
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /**
   * The versions a source reported for cards the user added from it (results, Check for a
   * newer version; spec/CARD-SOURCES.md §3.8): each becomes the origin's `seen_version`, null
   * when it's the version the user has. A version already recorded writes nothing.
   */
  Rpc.make("NoteRemoteVersions", {
    payload: {
      userId: UserId,
      sourceId: Schema.String,
      items: Schema.Array(Schema.Struct({ remoteId: Schema.String, version: Schema.String })).check(
        Schema.isMaxLength(200)
      )
    },
    success: Schema.Struct({ noted: Schema.Int }),
    error: StorageError
  }),
  /** The source's version the user took into their card (Review and merge, Replace): the origin's `remote_version`. */
  Rpc.make("TakeRemoteVersion", {
    payload: { userId: UserId, entityId: EntityId, version: Schema.String },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Add as a separate card (§3.8): the source's newer file as a new card, stored as an import
   * of it is, with no origin row (the first card keeps it), and that version taken on the
   * first card, in one transaction.
   */
  Rpc.make("AdoptRemoteVersionAsCard", {
    payload: { userId: UserId, entityId: EntityId, version: Schema.String, file: AdoptFields.file },
    success: Schema.Struct({ entityId: EntityId, refId: RefId }),
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  // --- Chats: the chat RPCs beyond the graph operations above (writes.ts).
  /**
   * A new version of a slot, selected in a fork (absent or null: the current one), if the
   * slot is still at the row version the user saw there: a swipe, an edit saved as a new
   * version, or the user's own version. The fork becomes current.
   */
  Rpc.make("AddSelectedVersion", {
    payload: {
      userId: UserId,
      slotId: SlotId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
    success: Schema.Struct({ chatId: ChatId, forkId: ForkId, version: Version }),
    error: Schema.Union([NotFound, StaleWrite, StorageError])
  }),
  /**
   * Changes a finished user-written version, as fork `forkId` shows it (absent or null: the
   * fork through its slot), in place when no other fork shows it: the trigger keeps the
   * earlier text. Otherwise the fork gets a copy with the new text, standing in for the
   * message's own version there (spec/FORK-INDEPENDENCE-DELTA.md §2.2), which is returned.
   */
  Rpc.make("AmendVersion", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      content: Schema.String,
      /** Its images from now on (absent: kept); the earlier set stays in its history. */
      images: Schema.optionalKey(MessageImages),
      expectedRowVersion: Schema.Int,
      /** The edit's draft (`version_edit`, this version), committed with it if it still holds that text. */
      commitDraft: Schema.optionalKey(CommitDraft),
      /** What regex scripts did to `content` (an edit's run-on-edit scripts), and the text typed. */
      rewrite: Schema.optionalKey(StoredRewrite)
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
      /** The reply's leading tagged sections so far; left as they are when absent. */
      replySections: Schema.optionalKey(ReplySections),
      status: VersionStatus,
      error: Schema.NullOr(VersionError)
    },
    success: Version,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Stars a live version or hides it from the arrows' cycle, or undoes either, in fork
   * `forkId` (absent or null: the fork through its slot); one write. Returns the version as
   * that fork shows it.
   */
  Rpc.make("SetVersionFlags", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      starred: Schema.optionalKey(Schema.Boolean),
      hidden: Schema.optionalKey(Schema.Boolean)
    },
    success: Schema.Struct({ chatId: ChatId, forkId: ForkId, version: Version }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Takes image `mediaId` of a live version out of the context in fork `forkId` (absent or
   * null: the fork through its slot), or puts it back; one write, of that fork's only. The
   * choice is on the message's own version, so a fork's copy of it shares it.
   */
  Rpc.make("SetImageExcluded", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      mediaId: Schema.String,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      excluded: Schema.Boolean
    },
    success: Schema.Struct({ chatId: ChatId, forkId: ForkId, slotId: SlotId }),
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
    payload: StartChatFields,
    success: StartChatResult,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A first turn with cards from a card source (spec/CARD-SOURCES.md §4.5, trigger 1), in one
   * transaction: each card as `AdoptRemoteCard` adds it (or the user's card from there), then
   * `StartChat` with each placeholder id (`src:<source>:<remote>`) replaced by its card's.
   * Either the cards and the chat all exist, or none of them does.
   */
  /**
   * Saving edits to a source's card (spec/CARD-SOURCES.md §4.5, trigger 2), in one
   * transaction: the card as `AdoptRemoteCard` adds it, its `remote_card` drafts moved to the
   * new card's fields, then `CommitEditorDrafts` of `fields` as its revision 2.
   */
  Rpc.make("AdoptAndCommitDrafts", {
    payload: {
      adopt: Schema.Struct(AdoptFields),
      fields: Schema.Array(
        Schema.Struct({ field: Schema.String, draftId: Schema.String, expectedRowVersion: Schema.Int })
      ),
      message: Schema.NullOr(Schema.String)
    },
    success: Schema.Struct({
      adopted: Schema.Struct({ entityId: EntityId, refId: RefId, existing: Schema.Boolean }),
      change: RefChange
    }),
    error: Schema.Union([NotFound, RefOperationRefused, StaleWrite, EditConflict, InvalidDocument, StorageError])
  }),
  /**
   * Revert for a source's card (`remote_card`, `<source>:<remote>`): its active drafts end,
   * their text kept in the bin's recovered texts, so its fields show the source's text again.
   */
  Rpc.make("RevertRemoteDrafts", {
    payload: { userId: UserId, targetId: Schema.String },
    success: Schema.Struct({ reverted: Schema.Int }),
    error: StorageError
  }),
  Rpc.make("AdoptAndStartChat", {
    payload: {
      adopt: Schema.Array(Schema.Struct({ placeholder: EntityId, ...AdoptFields })).check(Schema.isMaxLength(20)),
      start: Schema.Struct(StartChatFields)
    },
    success: Schema.Struct({
      ...StartChatResult.fields,
      adopted: Schema.Array(
        Schema.Struct({ placeholder: EntityId, entityId: EntityId, refId: RefId, existing: Schema.Boolean })
      )
    }),
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /**
   * A message (or, `generate`, a reply) under `parentSlotId`: posted, or queued when the
   * parent's selected version is still generating (DESIGN §2.2).
   */
  Rpc.make("SendOrQueue", {
    payload: {
      images: Schema.optionalKey(MessageImages),
      imageDraftIds: Schema.optionalKey(ComposerImageIds),
      userId: UserId,
      chatId: ChatId,
      /** The fork it's sent in, as AppendMessage takes it. */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
      commitDraft: CommitDraft,
      /** What regex scripts did to `content` as it was sent, and the text typed. */
      rewrite: Schema.optionalKey(StoredRewrite),
      /**
       * Who replies after its reply, in turn (DESIGN §2.3): queued as the round's entries behind
       * that reply. A send at the fork's tip first drops the round already queued there.
       */
      round: Schema.optionalKey(Schema.Array(EntityId)),
      /** The reply's speaker and the round's are Auto's picks: the decision model may change each (DESIGN §2.3). */
      autoPick: Schema.optionalKey(Schema.Boolean)
    },
    success: Schema.Union([
      /** `queue`: the chat's queue, when the post queued the rest of a round behind it. */
      Schema.TaggedStruct("Posted", { result: AppendResult, queue: Schema.optionalKey(Schema.Array(QueuedMessage)) }),
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
      expectedRowVersion: Schema.Int,
      draft: Schema.optionalKey(Schema.Struct({ draftId: Schema.String, session: Schema.Int })),
      rewrite: Schema.optionalKey(StoredRewrite)
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
    payload: {
      userId: UserId,
      slotId: SlotId,
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedVersionId: VersionId
    },
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
  /**
   * The fork's stopped round goes on (DESIGN §2.3): its entries wait at the fork's tip again, and
   * when nothing is being written there the first posts as a reply (`next`, to start).
   */
  Rpc.make("ContinueRound", {
    payload: { userId: UserId, chatId: ChatId, forkId: Schema.NullOr(ForkId) },
    success: QueueOutcome,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The fork's round entries, waiting or stopped, dropped. */
  Rpc.make("EndRound", {
    payload: { userId: UserId, chatId: ChatId, forkId: Schema.NullOr(ForkId) },
    success: QueueOutcome,
    error: Schema.Union([NotFound, StorageError])
  }),
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
      /** The reply's leading tagged sections; left as they are when absent. */
      replySections: Schema.optionalKey(ReplySections),
      status: VersionStatus,
      error: Schema.NullOr(VersionError),
      /** What regex scripts did to `content` and `reasoning` as it finished, and the text before. */
      rewrite: Schema.optionalKey(StoredRewrite)
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
  /**
   * A card's Character Author's Note from ST's settings (DESIGN §4.1): a private card note,
   * on in every chat where ST had "Use character author's note" ticked. A re-import merges
   * into the one an earlier import made. Returns the note's entity, and whether it's new.
   */
  Rpc.make("StImportCharacterNote", {
    payload: {
      modifiedAt: Schema.optionalKey(Schema.Number),
      userId: UserId,
      cardEntityId: EntityId,
      prompt: Schema.String,
      useChara: Schema.Boolean,
      /**
       * Where it goes: ST put it before, after or in place of the chat's author's note, which
       * the import turns into the concrete place of the folder's default author's note.
       */
      placement: NoteDoc.fields.placement,
      scanLore: Schema.Boolean,
      sourcePath: Schema.String
    },
    success: Schema.Struct({ entity: EntityId, created: Schema.Boolean }),
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /** Adopts ST's selected preset only while the user has no stored default. */
  Rpc.make("StImportDefaultPreset", {
    payload: { userId: UserId, importId: Schema.String, refId: RefId },
    success: Schema.Boolean,
    error: Schema.Union([ImportLeaseLost, NotFound, StorageError])
  }),
  /** Adopts ST's default persona only while the user has no stored default. */
  Rpc.make("StImportDefaultPersona", {
    payload: { userId: UserId, importId: Schema.String, entityId: EntityId },
    success: Schema.Boolean,
    error: Schema.Union([ImportLeaseLost, NotFound, StorageError])
  }),
  Rpc.make("StImportBegin", {
    payload: { userId: UserId, importId: Schema.String },
    success: Schema.Void,
    error: StorageError
  }),
  // --- ST import jobs (stImportJobs.ts): what the import page lists.
  /** A new job, running; an upload of the user's still running ends as interrupted (a new run fences it). */
  Rpc.make("StImportJobStart", {
    payload: {
      userId: UserId,
      id: Schema.String,
      mode: Schema.Literals(["path", "upload"]),
      source: Schema.String,
      root: Schema.NullOr(Schema.String),
      prefix: Schema.String,
      filesTotal: Schema.Int,
      bytesTotal: Schema.Number,
      at: Schema.Number
    },
    success: Schema.Void,
    error: StorageError
  }),
  /**
   * A running job's progress, and with `end` its outcome. Only a job still running changes,
   * so a job ended elsewhere (cancelled, interrupted) stays as it ended. `report`, when
   * given, replaces the stored one. Whether the job was running.
   */
  Rpc.make("StImportJobUpdate", {
    payload: {
      userId: UserId,
      id: Schema.String,
      at: Schema.Number,
      filesTotal: Schema.Int,
      filesDone: Schema.Int,
      bytesTotal: Schema.Number,
      bytesDone: Schema.Number,
      currentFile: Schema.NullOr(Schema.String),
      countsJson: Schema.String,
      attention: Schema.Int,
      reportJson: Schema.optionalKey(Schema.String),
      notSentJson: Schema.optionalKey(Schema.String),
      end: Schema.optionalKey(
        Schema.Struct({
          status: Schema.Literals(["complete", "failed", "cancelled", "interrupted"]),
          error: Schema.NullOr(Schema.String)
        })
      )
    },
    success: Schema.Boolean,
    error: StorageError
  }),
  /** A finished job's report again, after the user acted on it (a chat linked, a run un-hidden). */
  Rpc.make("StImportJobReport", {
    payload: {
      userId: UserId,
      id: Schema.String,
      reportJson: Schema.String,
      countsJson: Schema.String,
      attention: Schema.Int
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** At startup: every job still running stopped with the server, keeping what it had. How many. */
  Rpc.make("StImportJobsInterrupted", {
    payload: { at: Schema.Number, error: Schema.String },
    success: Schema.Int,
    error: StorageError
  }),
  Rpc.make("StImportJobSeen", {
    payload: { userId: UserId, id: Schema.String, at: Schema.Number },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Removes one finished job, or (null) all the user's finished ones; how many. */
  Rpc.make("StImportJobsClear", {
    payload: { userId: UserId, id: Schema.NullOr(Schema.String) },
    success: Schema.Int,
    error: StorageError
  }),
  Rpc.make("StImportStartChat", {
    payload: {
      groupId: Schema.optionalKey(Schema.String),
      arrival: Schema.optionalKey(StArrival),
      userId: UserId,
      parentRecordId: Schema.optionalKey(Schema.String),
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
      /** Exact normalized message hashes from the format worker; optional for plugins. */
      hashes: Schema.optionalKey(Schema.Array(Schema.String)),
      /** Each speaker key of the messages, as a card of the user's, or null. */
      speakers: Schema.Record(Schema.String, Schema.NullOr(EntityId)),
      /** Full-folder cards/personas by speaker; a manual link alone never dates their arrival. */
      arrivalRefs: Schema.optionalKey(Schema.Record(Schema.String, RefId)),
      groupArrival: Schema.optionalKey(StArrival),
      groupId: Schema.optionalKey(Schema.String)
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
      /** A branch's parent file's record. An ST file's name never names its fork (owner, 2026-11-01). */
      fork: Schema.NullOr(Schema.Struct({ parentRecordId: Schema.String })),
      /**
       * ST opens the file's card or group on it (`chat`, `chat_id`): the chat opens on its fork
       * here, unless the user has chatted or branched in the chat since it was imported.
       */
      stCurrent: Schema.optionalKey(Schema.Boolean)
    },
    success: Schema.Struct({
      notes: Schema.Record(Schema.String, EntityId)
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
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      throughSlotId: SlotId
    },
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
  /**
   * Live text is what's sent (owner, 2026-11-01): before a reply is assembled, the library
   * entries the assembly read (`used`, as `AssembleContext` reported them) whose fields
   * changed since their last revision get a revision of their live text, labelled with the
   * reply (`usedBy`, origin `generation`), in one transaction. `cut`: how many were cut; the
   * reply is assembled again when any was. Drafts that wouldn't make a valid document stay
   * as they are (the head is sent); the held structural changes never go in.
   */
  Rpc.make("CheckpointLiveText", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.NullOr(ForkId),
      slotId: SlotId,
      /** The version a reply writes; null for a summary. */
      versionId: Schema.NullOr(VersionId),
      /** A summary request: the messages it covers, by number (`slotId` is the last). */
      summary: Schema.optionalKey(Schema.Struct({ from: Schema.Int, to: Schema.Int })),
      /** The message the reply's history ends at, where a chat's note is edited from. */
      leafSlotId: Schema.NullOr(SlotId),
      /** The reply's number in the chat, from 1. */
      message: Schema.Int,
      used: Schema.Array(UsedEntry)
    },
    success: Schema.Struct({ cut: Schema.Int }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Every field changed since the ref's last revision (a chat's note: the revision bound where
   * it's edited) back to that revision's value, each as a new state of its edit history, so the
   * text there now stays one state back; no revision is written. The held changes aside.
   */
  Rpc.make("RevertEditorDrafts", {
    payload: { userId: UserId, refId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: Schema.Struct({ reverted: Schema.Int }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A revision's message (a label, never content), owned revisions of the ref's entity only. */
  Rpc.make("SetRevisionMessage", {
    payload: { userId: UserId, refId: RefId, revisionId: RevisionId, message: Schema.NullOr(Schema.String) },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A new revision on the head with an earlier revision's content. */
  Rpc.make("RestoreRevision", {
    payload: {
      userId: UserId,
      refId: RefId,
      revisionId: RevisionId,
      expectedRowVersion: Schema.Int,
      chatNote: Schema.optionalKey(ChatNotePosition)
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** ForkRef, optionally moving the ref's unsaved drafts to the fork. */
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
  /**
   * A card of its own forked from the ref's head (spec/CARD-FORKS-DELTA.md §2): its content
   * with the three names given, its tags and its notes copied, and the unsaved
   * text of the ref and its notes moved to it (but the names). Refused for a display name and version another card has.
   */
  Rpc.make("ForkCard", {
    payload: {
      userId: UserId,
      refId: RefId,
      name: Schema.String,
      nickname: Schema.String,
      characterVersion: Schema.String
    },
    success: LibraryRef,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  Rpc.make("ForkCardForChat", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: Schema.NullOr(SlotId),
      entityId: EntityId,
      name: Schema.String,
      nickname: Schema.String,
      characterVersion: Schema.String
    },
    success: Schema.Struct({ ref: LibraryRef, choices: Schema.Array(ComposerChoice) }),
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /** "Mark as a fork of…" an existing card, or with null "Unlink"; neither card's content changes. */
  Rpc.make("SetCardParent", {
    payload: { userId: UserId, entityId: EntityId, parentEntityId: Schema.NullOr(EntityId) },
    success: CardFamily,
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
  /** A card's or preset's panel permissions (spec/HTML-MESSAGES.md §3.4); without a row version, from a chat. */
  Rpc.make("SetHtmlApproval", {
    payload: {
      userId: UserId,
      refId: RefId,
      scripts: Schema.Boolean,
      network: Schema.Boolean,
      expectedRowVersion: Schema.optionalKey(Schema.Int)
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  Rpc.make("SetRegexApproval", {
    payload: { userId: UserId, refId: RefId, approved: Schema.Boolean, expectedRowVersion: Schema.Int },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** A new avatar for a card, already written to media storage. */
  Rpc.make("RecordMessageImage", {
    payload: {
      userId: UserId,
      media: Schema.Struct({
        sha256: Sha256,
        mime: Schema.String,
        byteSize: Schema.Int,
        width: Schema.NullOr(Schema.Int),
        height: Schema.NullOr(Schema.Int)
      })
    },
    success: Schema.String,
    error: StorageError
  }),
  /** With `crop`, the cutout chosen for it (ARCHITECTURE.md §14.5c); without, the default. */
  Rpc.make("AddCardAsset", {
    payload: {
      userId: UserId,
      refId: RefId,
      expectedRowVersion: Schema.Int,
      media: ImportedMedia,
      name: Schema.String.check(Schema.isMaxLength(255))
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  Rpc.make("ChangeCardAsset", {
    payload: { userId: UserId, refId: RefId, uri: Schema.String, change: AssetChange, expectedRowVersion: Schema.Int },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  Rpc.make("SetCardAvatar", {
    payload: {
      userId: UserId,
      refId: RefId,
      expectedRowVersion: Schema.Int,
      media: ImportedMedia,
      crop: Schema.optionalKey(AvatarCrop)
    },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** The card's Picture and Portrait cuts, chosen together; null resets both to the original/default. */
  Rpc.make("SetCardAvatarCrop", {
    payload: { userId: UserId, refId: RefId, expectedRowVersion: Schema.Int, crop: Schema.NullOr(AvatarCrop) },
    success: RefChange,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** A new note on the card; with `link`, a slot showing that shared note of the user's. */
  Rpc.make("CreateCardNote", {
    payload: {
      chatNote: Schema.optionalKey(ChatNotePosition),
      userId: UserId,
      cardRefId: RefId,
      title: Schema.String,
      link: Schema.optionalKey(EntityId)
    },
    success: LibraryRef,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A note of the live chat's own (DESIGN §4.1), an upstream like a card's note; `link` as above. */
  Rpc.make("CreateChatNote", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      userId: UserId,
      chatId: ChatId,
      title: Schema.String,
      link: Schema.optionalKey(EntityId),
      replaces: Schema.optionalKey(ReplaceTarget),
      content: Schema.optionalKey(Schema.String)
    },
    success: LibraryRef,
    error: Schema.Union([NotFound, InvalidDocument, StorageError])
  }),
  /**
   * A shared named note (DESIGN §4.1). With `fromNoteRefId`, from that slot, which is linked
   * to it in the same transaction: a chat's note at `chatNote`, by a branch-local revision.
   */
  Rpc.make("CreateSharedNote", {
    payload: {
      userId: UserId,
      title: Schema.String,
      content: Schema.String,
      fromNoteRefId: Schema.optionalKey(RefId),
      chatNote: Schema.optionalKey(ChatNotePosition)
    },
    success: LibraryRef,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  /** A linked slot becomes its own copy of the shared note's text, as `CreateSharedNote` writes a slot. */
  Rpc.make("UnlinkNote", {
    payload: { userId: UserId, noteRefId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: LibraryRef,
    error: Schema.Union([NotFound, StaleWrite, RefOperationRefused, StorageError])
  }),
  // --- Generation (ARCHITECTURE.md §15).
  /**
   * Opens a generation's rollout before its request is sent (DATA-MODEL §7.1): the row, its
   * frozen context snapshot (JSON text, stored as given), compact lore activation receipts, the version's link to it and to
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
      /** The fork it generates in (absent or null: the fork through the leaf, the current one first). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      connectionId: ConnectionId,
      modelId: ModelId,
      snapshot: Schema.String,
      /** The orchestration mode it ran in, when not plain (spec/AGENTIC.md §6). */
      mode: Schema.optionalKey(Schema.String),
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
  /**
   * An agent rollout's transcript as it stands (spec/AGENTIC.md §3.3): the whole of it, replacing
   * what was saved, and its step count (tool calls) for the version's badge.
   */
  /**
   * A chat-state tool call's state events, attached to the rollout's version, with its receipt
   * (rolloutWrites.ts). Receipted already: nothing is written, and the first result comes back.
   */
  Rpc.make("ApplyRolloutEffect", {
    payload: {
      userId: UserId,
      rolloutId: Schema.String,
      toolCallId: Schema.String,
      events: Schema.Array(StoredStateEventData),
      /**
       * Notes the call writes (spec/AGENTIC.md §4.3), before its events: `create` makes a chat
       * note (an agent's, `origin: generation`) and turns it on, `revise` makes a revision of a
       * note on `parent` and binds it; both attached to the version, from the next message on.
       */
      notes: Schema.optionalKey(
        Schema.Array(
          Schema.Union([
            Schema.Struct({ create: Schema.Record(Schema.String, Schema.Unknown) }),
            Schema.Struct({
              revise: Schema.Struct({
                note: EntityId,
                parent: Schema.String,
                doc: Schema.Record(Schema.String, Schema.Unknown)
              })
            })
          ])
        )
      ),
      result: Schema.String
    },
    success: Schema.Struct({ result: Schema.String, replayed: Schema.Boolean }),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("SaveRolloutTranscript", {
    payload: { userId: UserId, rolloutId: Schema.String, transcript: Schema.String, steps: Schema.Int },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A resumed agent reply (spec/AGENTIC.md §4.2), in one transaction: a new generating version
   * of `versionId`'s slot, selected in the fork, sourced from it, with origin `resumed`; its
   * rollout, a child of the stopped one, with the same frozen snapshot, model and mode and the
   * transcript kept; the stopped version's state events copied, of its tool calls only those of
   * `keptCalls`, with their receipts; and the discarded tail as a `rollout_branches` row. Refused
   * (`NotResumable`) while another resume of the version is still being written.
   */
  Rpc.make("StartResumedVersion", {
    payload: {
      userId: UserId,
      versionId: VersionId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      expectedRowVersion: Schema.Int,
      rolloutId: Schema.String,
      version: NewVersion,
      transcript: Schema.String,
      steps: Schema.Int,
      keptCalls: Schema.Array(Schema.String),
      /** What was cut, and why (`resume`, `edit`); none when nothing was. */
      branch: Schema.NullOr(Schema.Struct({ reason: Schema.String, messages: Schema.String }))
    },
    success: Schema.Struct({ chatId: ChatId, forkId: ForkId, version: Version }),
    error: Schema.Union([NotFound, StaleWrite, NotResumable, StorageError])
  }),
  /** At startup: rollouts a previous process left running are interrupted. */
  Rpc.make("InterruptRollouts", { success: Schema.Struct({ interrupted: Schema.Int }), error: StorageError }),
  // --- Decision models (spec/AGENTIC.md §7; db/decisions.ts)
  /** A connection's decision settings, replacing its own; NotFound unless it (and the model) is the user's. */
  Rpc.make("SetDecisionSettings", {
    payload: {
      userId: UserId,
      connectionId: ConnectionId,
      model: Schema.NullOr(ModelId),
      points: Schema.Record(Schema.String, DecisionPointSetting)
    },
    success: Schema.Array(ConnectionDecisions),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A decision call's rollout (kind `decision`), its state and questions as the snapshot. */
  Rpc.make("StartDecisionRollout", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      rolloutId: Schema.String,
      /** The message it decides for: the reply being written, or the one that just finished. */
      slotId: Schema.NullOr(SlotId),
      forkId: Schema.NullOr(ForkId),
      connectionId: ConnectionId,
      modelId: ModelId,
      requestClass: Schema.Literals(["interactive", "background"]),
      snapshot: Schema.String
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Closes a decision rollout with its outcome (JSON: answers, verdict, source) and its ledger rows' usage. */
  Rpc.make("FinishDecisionRollout", {
    payload: {
      userId: UserId,
      rolloutId: Schema.String,
      status: Schema.Literals(["completed", "stopped", "failed"]),
      error: Schema.NullOr(Schema.String),
      result: Schema.String
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * The decision model's "Who replies next" (spec/AGENTIC.md §7): the speaker of a reply Auto
   * picked, changed before anything is written. False when the reply has text by now, or isn't
   * Auto's pick.
   */
  Rpc.make("PickSpeaker", {
    payload: {
      userId: UserId,
      rolloutId: Schema.String,
      versionId: VersionId,
      speakerEntityId: EntityId,
      /** The name the model was asked about, and how sure it was. */
      name: Schema.String,
      confidence: Schema.Number
    },
    success: Schema.Boolean,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A reply whose speaker the decision model was to choose, once it didn't (nothing to ask, or no
   * answer sure enough): Auto's pick stands, and the reply shows it. False when already settled.
   */
  Rpc.make("SettleSpeaker", {
    payload: { userId: UserId, versionId: VersionId },
    success: Schema.Boolean,
    error: StorageError
  }),
  /** State events a decision attaches to a version of its chat, with the decision as their origin. */
  Rpc.make("ApplyDecisionEffect", {
    payload: {
      userId: UserId,
      rolloutId: Schema.String,
      versionId: VersionId,
      /** The state the point read: a later user/tool change or swipe makes the effect stale. */
      expectedState: Schema.String,
      events: Schema.Array(StoredStateEventData)
    },
    success: Schema.Boolean,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Undo of an away mark the scene check set (spec/CHARACTER-CONTEXT.md §5, unit C9), in one
   * transaction: the user's presence event replaces the decision's, and every version written
   * since that recorded the character away for it is corrected to count it present
   * (`db/decisions.ts`). Null when the event isn't a live away mark of the scene check.
   */
  Rpc.make("CorrectPresence", {
    payload: { userId: UserId, chatId: ChatId, forkId: ForkId, eventId: Schema.String },
    success: Schema.NullOr(
      Schema.Struct({
        /** The user's event that replaced the decision's. */
        eventId: Schema.String,
        /** The versions whose presence record was corrected. */
        corrected: Schema.Array(VersionId)
      })
    ),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The account defaults, including its new-chat persona; choices must be owned and live. */
  Rpc.make("SetGenerationDefaults", {
    payload: { userId: UserId, defaults: GenerationDefaults },
    success: GenerationDefaults,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Replaces the account's global regex scripts, at the revision the caller read (StaleWrite otherwise). */
  Rpc.make("SetGlobalRegex", {
    payload: { userId: UserId, scripts: GlobalScripts, expectedRevision: Schema.Int },
    success: GlobalRegex,
    error: Schema.Union([StaleWrite, StorageError])
  }),
  /**
   * A chat's summarization settings changed field by field (DESIGN §8): read and written as a
   * new chat-wide `lcm.settings` event in one transaction; null removes a field.
   */
  Rpc.make("ChangeLcmSettings", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      change: LcmSettingsChange
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError, LcmSettingsInvalid])
  }),
  /** Only the defaults named, merged into the stored ones in the same transaction. */
  Rpc.make("ChangeGenerationDefaults", {
    payload: { userId: UserId, change: GenerationDefaultsChange },
    success: GenerationDefaults,
    error: Schema.Union([NotFound, StorageError, LcmSettingsInvalid])
  }),
  /**
   * How a connection of the user's counts tokens: `via` null on this server, else through that
   * connection's provider; NotFound when either connection isn't theirs.
   */
  Rpc.make("SetTokenCounting", {
    payload: { userId: UserId, connectionId: ConnectionId, via: Schema.NullOr(ConnectionId) },
    success: Schema.Array(TokenCountingChoice),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The user's display choices, merged in one writer transaction. */
  Rpc.make("SetDisplayPrefs", {
    payload: { userId: UserId, prefs: DisplayPrefsChange },
    success: DisplayPrefs,
    error: StorageError
  }),
  // --- Card sources (spec/CARD-SOURCES.md §5.2): the account's choices, merged by source.
  Rpc.make("ChangeSourcePrefs", {
    payload: {
      userId: UserId,
      change: Schema.Struct({
        enabled: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.Boolean))),
        keys: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
        rating: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String)))
      })
    },
    success: SourcePrefs,
    error: StorageError
  }),
  /** Puts a remote card first in "Recently viewed", keeping the latest 50. */
  Rpc.make("RecordRecentRemote", {
    payload: { userId: UserId, entry: RecentRemote },
    success: SourcePrefs,
    error: StorageError
  }),
  Rpc.make("ClearRecentRemote", {
    payload: { userId: UserId, sourceId: Schema.NullOr(Schema.String) },
    success: SourcePrefs,
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
   * The fork to open for the alternate at `index` among `slotId`'s (the reachable siblings,
   * oldest first): the live fork through it that was current most recently. With none, one
   * is made there, from `forkId` (the fork shown), with its tip on that alternate's newest
   * replies. Switching changes no fork's history and doesn't make the fork current; nor
   * does it carry composer text (DESIGN §6.2).
   */
  Rpc.make("SwitchBranch", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      slotId: SlotId,
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      forkId: Schema.NullOr(ForkId)
    },
    success: Schema.Struct({ slotId: SlotId, fork: Fork, chat: Chat }),
    error: Schema.Union([NotFound, StorageError])
  })
) {}

export class ReadOps extends RpcGroup.make(
  /** What a merge would bring (spec/CHAT-MERGE.md §3), as `MergeChat` computes it. */
  Rpc.make("PreviewChatMerge", {
    payload: { userId: UserId, ...MergeRequest.fields },
    success: ChatMergePreview,
    error: Schema.Union([NotFound, StaleWrite, MergeRefused, StorageError])
  }),
  /** The merge whose join message is `slotId`. */
  Rpc.make("GetMerge", {
    payload: { userId: UserId, chatId: ChatId, slotId: SlotId },
    success: MergeInfo,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A merge's frozen copy of the merged messages, in order. */
  Rpc.make("MergeMessages", {
    payload: { userId: UserId, chatId: ChatId, mergeId: Schema.String, offset: Schema.Int, limit: Schema.Int },
    success: Schema.Array(MergedMessage),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("GetSplitChats", {
    payload: { userId: UserId, chatId: ChatId, forkId: Schema.NullOr(ForkId) },
    success: SplitChats,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("GetBinLimits", { payload: { userId: UserId }, success: BinLimits, error: StorageError }),
  Rpc.make("GetImageTokenCount", {
    payload: { userId: UserId, sha256: Sha256, kind: Schema.String, modelKey: Schema.String, detail: Schema.String },
    success: Schema.NullOr(Schema.Int),
    error: StorageError
  }),
  Rpc.make("GetCostSettings", { payload: { userId: UserId }, success: CostSettings, error: StorageError }),
  Rpc.make("ListSnippets", {
    payload: { userId: UserId, ...SnippetContext, query: Schema.optionalKey(Schema.String) },
    success: Schema.Array(Snippet),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("PreviewForkNotes", {
    payload: { userId: UserId, chatId: ChatId, fromForkId: Schema.NullOr(ForkId), atSlotId: Schema.NullOr(SlotId) },
    success: Schema.Array(ForkNote),
    error: Schema.Union([NotFound, StorageError])
  }),
  historyReadRpcs[3]
    .setPayload(Schema.Struct({ ...historyReadRpcs[3].payloadSchema.fields, userId: UserId }))
    .setError(Schema.Union([NotFound, HistoryRejected, StorageError])),
  historyReadRpcs[0]
    .setPayload(Schema.Struct({ ...historyReadRpcs[0].payloadSchema.fields, userId: UserId }))
    .setError(Schema.Union([NotFound, HistoryRejected, StorageError])),
  historyReadRpcs[1]
    .setPayload(Schema.Struct({ ...historyReadRpcs[1].payloadSchema.fields, userId: UserId }))
    .setError(Schema.Union([NotFound, HistoryRejected, StorageError])),
  historyReadRpcs[2]
    .setPayload(Schema.Struct({ ...historyReadRpcs[2].payloadSchema.fields, userId: UserId }))
    .setError(Schema.Union([NotFound, HistoryRejected, StorageError])),
  Rpc.make("ShellLibrary", {
    /** `recompute`: ignore every stored summary (tests compare the two). */
    payload: { userId: UserId, recompute: Schema.optionalKey(Schema.Boolean) },
    success: ShellLibraryRead,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("ListArchiveCandidates", {
    payload: { userId: UserId, criteria: ArchiveCriteria },
    success: Schema.Array(ArchiveCandidate),
    error: StorageError
  }),
  Rpc.make("ShellCards", { payload: { userId: UserId }, success: ShellCardsRead, error: StorageError }),
  /** Bounded post-write refreshes; null asks the caller to use the background read. */
  Rpc.make("ShellCardsLive", {
    payload: { userId: UserId },
    success: Schema.NullOr(ShellCardsRead),
    error: StorageError
  }),
  Rpc.make("ShellForks", {
    payload: { userId: UserId, view: ShellForksView },
    success: ShellForksRead,
    error: StorageError
  }),
  Rpc.make("ShellForksLive", {
    payload: { userId: UserId, view: ShellForksView },
    success: Schema.NullOr(ShellForksRead),
    error: StorageError
  }),
  Rpc.make("GetSummaryRevisionRequest", {
    payload: { userId: UserId, revisionId: SummaryRevisionId },
    success: SummaryDetails,
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("GetSummaryDetails", {
    payload: { userId: UserId, summaryId: SummaryId },
    success: SummaryDetails,
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("GetSummary", {
    payload: { forkId: Schema.optionalKey(Schema.NullOr(ForkId)), userId: UserId, summaryId: SummaryId },
    success: Summary,
    error: Schema.Union([StorageError, NotFound])
  }),
  /** The layer in use on the path to a leaf, with the failed summaries and unfinished jobs on it. */
  Rpc.make("GetLcmState", {
    payload: { userId: UserId, chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), leafSlotId: SlotId },
    success: LcmState,
    error: Schema.Union([StorageError, NotFound])
  }),
  /** Every summary on the path overlapping message depths `fromDepth`..`toDepth`, without their text. */
  Rpc.make("GetLcmCoverage", {
    payload: {
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      userId: UserId,
      chatId: ChatId,
      leafSlotId: SlotId,
      fromDepth: Schema.Int,
      toDepth: Schema.Int,
      fromPosition: Schema.optionalKey(Schema.Int),
      toPosition: Schema.optionalKey(Schema.Int),
      includeResolved: Schema.optionalKey(Schema.Boolean)
    },
    success: LcmCoverage,
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("ListSummaryRevisions", {
    payload: { forkId: Schema.optionalKey(Schema.NullOr(ForkId)), userId: UserId, summaryId: SummaryId },
    success: Schema.Array(SummaryRevision),
    error: Schema.Union([StorageError, NotFound])
  }),
  /** The imported summary a chat could adopt and the work enabling LCM would do, measured (priced by the caller). */
  Rpc.make("ReadLcmImported", {
    payload: { userId: UserId, chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), leafSlotId: SlotId },
    success: Schema.NullOr(ImportedLcmSummary),
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("EstimateBackfill", {
    payload: { userId: UserId, chatId: ChatId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)), leafSlotId: SlotId },
    success: BackfillBasis,
    error: Schema.Union([StorageError, NotFound])
  }),
  /** The chat's newest backfill and what the ledger shows spent against it; null when it never had one. */
  Rpc.make("GetBackfill", {
    payload: { forkId: Schema.optionalKey(Schema.NullOr(ForkId)), userId: UserId, chatId: ChatId },
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
      /** Read the fork's path (absent or null: the current fork's), unless `leafSlotId` names a leaf. */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      leafSlotId: Schema.NullOr(SlotId),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PATH_WINDOW }))
    },
    success: Schema.Struct({
      entries: Schema.Array(PathEntry),
      olderLeafSlotId: Schema.NullOr(SlotId),
      /**
       * The fork's tip, which appends go below (spec/MESSAGE-INSERT.md §2.3): not always the last
       * entry, which can be a message inserted after it.
       */
      tipSlotId: Schema.NullOr(SlotId)
    }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Earlier saved text of an owned human-written version. */
  Rpc.make("VersionAmendments", {
    payload: { userId: UserId, versionId: VersionId },
    success: Schema.Array(VersionAmendment),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A slot's own versions as fork `forkId` shows them (absent or null: the fork through it,
   * forkAt): a copy it amended in its original's place, with the fork's stars and picker flags.
   */
  Rpc.make("ListVersions", {
    payload: { userId: UserId, slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
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
    payload: {
      userId: UserId,
      chatId: ChatId,
      /** The viewed leaf when reading an earlier position; forkId takes precedence. */
      leafSlotId: Schema.optionalKey(Schema.NullOr(SlotId)),
      slotId: Schema.NullOr(SlotId),
      /** Composer/next-state read: include the tip’s trailing insertions when slotId is the tip. */
      displayEnd: Schema.optionalKey(Schema.Boolean),
      /** Whose selections decide the version-attached events (absent or null: the fork through the slot, forkAt). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId))
    },
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
  Rpc.make("GetComposerImages", {
    payload: { userId: UserId, ...ComposerImageKey, ids: ComposerImageIds },
    success: Schema.Array(ComposerImage),
    error: Schema.Union([NotFound, StorageError])
  }),
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
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DraftHistoryPolicy.maxEntries + 1 })),
      before: Schema.optionalKey(Schema.Int)
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
  /** The forks that show what the user's bin items hold (`BinForkShown`), for the warning before deleting for good. */
  Rpc.make("BinItemForks", {
    payload: { userId: UserId, itemIds: Schema.Array(Schema.String) },
    success: Schema.Array(BinForkShown),
    error: StorageError
  }),
  /** Every branch deleting the user's bin items for good affects (`BinBranch`), for the confirmation's list. */
  Rpc.make("BinItemBranches", {
    payload: { userId: UserId, itemIds: Schema.Array(Schema.String) },
    success: Schema.Array(BinBranch),
    error: StorageError
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
  /** The user's library of one kind: every entry, forks included. */
  Rpc.make("ListLibrary", {
    payload: {
      userId: UserId,
      kind: EntityKind,
      /** Only entities with this tag, e.g. "persona" for the persona folder. */
      tag: Schema.NullOr(Schema.String),
      withFilterData: Schema.optionalKey(Schema.Boolean),
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
      before: Schema.optionalKey(RevisionId),
      chatNote: Schema.optionalKey(ChatNotePosition)
    },
    success: Schema.Array(Revision),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("ForkMergeStatus", {
    payload: { userId: UserId, refId: RefId },
    success: MergeStatus,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  Rpc.make("PreviewForkMerge", {
    payload: { userId: UserId, refId: RefId, theirsRevisionId: Schema.optionalKey(RevisionId) },
    success: ForkMergePreview,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  Rpc.make("LibraryGenealogy", {
    payload: { userId: UserId, refId: RefId },
    success: LibraryGenealogy,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
  }),
  /** What merging in the followed ref would produce, for the conflict resolver. */
  Rpc.make("PreviewMerge", {
    payload: { userId: UserId, refId: RefId },
    success: MergePreview,
    error: Schema.Union([NotFound, RefOperationRefused, StorageError])
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
  /** When each of the user's models last wrote a reply: the model picker's Last used. */
  Rpc.make("ListModelUse", {
    payload: { userId: UserId },
    success: Schema.Array(ModelUse),
    error: StorageError
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
  /**
   * A card as "Import a new version…" previews it (@rp/shared/cardReplace.ts): its head, the
   * text of its first note, its picture's hash, and how many chats follow it or keep a fixed
   * revision. Anything but the user's own card is NotFound.
   */
  Rpc.make("CardReplaceSource", {
    payload: { userId: UserId, refId: RefId },
    success: CardReplaceSource,
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
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
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
  /** A slot as a fork shows it (absent or null: the fork through it, forkAt). */
  Rpc.make("GetSlot", {
    payload: { userId: UserId, slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
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
      chat: Schema.optionalKey(
        Schema.Struct({
          chatId: ChatId,
          bindings: CardBindings,
          history: Schema.optionalKey(
            Schema.Struct({
              forkId: Schema.NullOr(ForkId),
              slotId: Schema.NullOr(SlotId),
              active: Schema.Array(EntityId)
            })
          )
        })
      )
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
   * The live chat's own notes, then these cards', by their upstream refs, oldest first, each
   * linked one with its shared note (whose text is in `doc.content`). A note an agent reply
   * wrote is among them only where that reply is shown (DESIGN §7.3 [D]).
   */
  Rpc.make("ChatNoteEntries", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: Schema.NullOr(SlotId),
      cards: Schema.Array(EntityId)
    },
    success: Schema.Array(
      Schema.Struct({
        ref: LibraryRef,
        doc: Doc,
        card: Schema.NullOr(EntityId),
        linked: Schema.NullOr(LinkedNote)
      })
    ),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * The user's shared notes not in the bin whose title has `query` (all without one), or the
   * one `refId` or `entityId` names.
   */
  Rpc.make("ListSharedNotes", {
    payload: {
      chatNote: Schema.optionalKey(ChatNotePosition),
      userId: UserId,
      query: Schema.optionalKey(Schema.String),
      refId: Schema.optionalKey(RefId),
      entityId: Schema.optionalKey(EntityId)
    },
    success: Schema.Array(SharedNote),
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
  /** The user's chat an ST import made with the latest message, not in the bin; null for none. */
  Rpc.make("StImportLatestChat", {
    payload: { userId: UserId },
    success: Schema.NullOr(
      Schema.Struct({
        chatId: ChatId,
        title: Schema.String,
        createdAt: Schema.Number,
        names: Schema.Array(Schema.String)
      })
    ),
    error: StorageError
  }),
  /** The user's import jobs, newest first (at most 200). */
  Rpc.make("ListStImportJobs", {
    payload: { userId: UserId },
    success: Schema.Array(StImportJob),
    error: StorageError
  }),
  Rpc.make("GetStImportJob", {
    payload: { userId: UserId, id: Schema.String },
    success: Schema.Struct({
      job: StImportJob,
      root: Schema.NullOr(Schema.String),
      prefix: Schema.String,
      reportJson: Schema.NullOr(Schema.String),
      notSentJson: Schema.String
    }),
    error: Schema.Union([NotFound, StorageError])
  }),
  // --- The card and preset editors (editorReads.ts).
  Rpc.make("GetCardGallery", {
    payload: { userId: UserId, refId: RefId },
    success: CardGallery,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("OpenEditor", {
    payload: { userId: UserId, refId: RefId, chatNote: Schema.optionalKey(ChatNotePosition) },
    success: EditorSnapshot,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The user's cards that are a fork or have one, with their own forks' count (every state, as CardFamily). */
  Rpc.make("CardFamilyIndex", {
    payload: { userId: UserId },
    success: Schema.Array(Schema.Struct({ entityId: EntityId, forks: Schema.Int })),
    error: StorageError
  }),
  /** Every card connected to a live card of the user's by forking (`cardFamily` in library.ts). */
  Rpc.make("CardFamily", {
    payload: { userId: UserId, entityId: EntityId },
    success: CardFamily,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A revision of the ref's own entity. */
  Rpc.make("GetRevisionDoc", {
    payload: { userId: UserId, refId: RefId, revisionId: RevisionId },
    success: Doc,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The existing first imported card note, using the same identity as ImportFile. */
  Rpc.make("GetCardImportNote", {
    payload: { userId: UserId, cardRefId: RefId },
    success: Schema.NullOr(EntityId),
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
      /** The fork it plans in (absent or null: the fork through the leaf, the current one first). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      /** Without one, only new chunks are planned. A reply may start re-summarizing; a finished job only continues it. */
      reason: Schema.optionalKey(Schema.Literals(["reply", "completion"]))
    },
    success: SummaryPlan,
    error: Schema.Union([StorageError, NotFound, AssemblyFailed])
  }),
  Rpc.make("AssembleSummary", {
    payload: {
      userId: UserId,
      jobId: Schema.String,
      attempt: Schema.Int,
      /** Data from the attempt's registered strategies, applied before budget checks. */
      instructions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
    },
    success: Schema.Struct({
      snapshot: Schema.String,
      generation: Schema.String,
      /** The library entries it read (`CheckpointLiveText`), and the messages it covers by number. */
      used: Schema.Array(UsedEntry),
      from: Schema.Int,
      to: Schema.Int
    }),
    error: Schema.Union([StorageError, NotFound, AssemblyFailed])
  }),
  Rpc.make("RoleProjections", { success: Schema.Array(RoleProjectionOption) }),
  Rpc.make("MergeLayouts", { success: Schema.Array(RoleProjectionOption) }),
  /** The away marks on a fork's display path through `slotId`, in fold order (`db/awayMarks.ts`). */
  Rpc.make("AwayMarks", {
    payload: { userId: UserId, chatId: ChatId, forkId: ForkId, slotId: Schema.NullOr(SlotId) },
    success: Schema.Array(AwayMark),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The context views installed (`contextViews`), as This chat's Context setting offers them. */
  Rpc.make("ContextViews", { success: Schema.Array(RoleProjectionOption) }),
  Rpc.make("AssembleContext", {
    payload: {
      partialBatch: Schema.optionalKey(Schema.Boolean),
      /** "Retry with…": this model instead of the chat's. */
      model: Schema.optionalKey(ModelChoice),
      userId: UserId,
      chatId: ChatId,
      slotId: SlotId,
      versionId: VersionId,
      /** The fork whose path and choices it's assembled from (absent or null: the fork through the slot). */
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      now: Schema.Number,
      timeZone: Schema.String,
      frozen: Schema.NullOr(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))),
      /** An agent reply's assembly (spec/AGENTIC.md §6). */
      agent: Schema.optionalKey(Schema.Struct({ instructions: Schema.String, speakerCardOnly: Schema.Boolean })),
      /** What decision models decided (spec/AGENTIC.md §7): the lorebook entries they admitted. */
      decisions: Schema.optionalKey(
        Schema.Struct({
          stamp: Schema.String,
          lore: Schema.Array(Schema.Struct({ entry: Schema.String, probability: Schema.Number }))
        })
      )
    },
    success: Schema.Struct({
      snapshot: Schema.String,
      generation: Schema.String,
      /** The library entries it read, for `CheckpointLiveText`; message number in `message`. */
      used: Schema.Array(UsedEntry),
      message: Schema.Int,
      /** What the `lore` decision point would ask about; absent when no entry the keys left out has a question. */
      loreDecision: Schema.optionalKey(
        Schema.Struct({
          stamp: Schema.String,
          candidates: Schema.Array(
            Schema.Struct({ key: Schema.String, title: Schema.String, question: Schema.String })
          ),
          recent: Schema.Array(Schema.Struct({ from: Schema.String, text: Schema.String }))
        })
      )
    }),
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
  /** An agent reply's steps, from its stored transcript (agentReads.ts); empty for a plain one. */
  Rpc.make("RolloutSteps", {
    payload: { userId: UserId, versionId: VersionId },
    success: Schema.Array(RolloutStep),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * The agent's `search_chat` over full-text search (agentReads.ts, spec/AGENTIC.md §4.5): the
   * messages on the path to `leafSlotId` in the fork, as the fork shows them, whose text has a
   * word starting with each of `tokens` (all of them; none: any), newest first, before display
   * position `before` when given; hidden and unfinished ones left out, template messages
   * (greetings) always, for the caller to fill in and match. Null when the fork places inserted
   * messages, whose numbering the display path gives: the caller reads the path instead.
   */
  Rpc.make("SearchChat", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.NullOr(ForkId),
      leafSlotId: SlotId,
      tokens: Schema.Array(Schema.String),
      before: Schema.NullOr(Schema.Int),
      limit: Schema.Int,
      /**
       * A separate context's viewer, as its identities through card replacements: only messages
       * it knew (spec/CHARACTER-CONTEXT.md §3, C5).
       */
      viewers: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
    },
    success: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          position: Schema.Int,
          speakerEntityId: Schema.NullOr(Schema.String),
          writer: Schema.String,
          macroMode: Schema.String,
          content: Schema.String
        })
      )
    ),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * Who knew each of these versions of the chat (`db/knowers.ts`): card ids, or null for
   * everyone. The agent's read tools leave out what a separate context's viewer didn't know.
   */
  Rpc.make("KnowersOf", {
    payload: { userId: UserId, chatId: ChatId, versionIds: Schema.Array(Schema.String) },
    success: Schema.Array(
      Schema.Struct({ versionId: Schema.String, knowers: Schema.NullOr(Schema.Array(Schema.String)) })
    ),
    error: StorageError
  }),
  /**
   * The agent's `lookup_lore` (agentReads.ts, spec/AGENTIC.md §4.5): the enabled entries of the
   * lorebooks the rollout's context was assembled with (its snapshot's `agentLore`), named by
   * `entry` (a title or uid), or holding every word of `query` (case aside) in their keys, title or
   * text, those matching by key first. Reads only: what's admitted to the context is the assembler's.
   */
  /**
   * The cards an agent reply's tools may name (spec/AGENTIC.md §4.6), each as the chat uses it
   * (`bindings`, else the chat's override, else the library entry, as ChatCards picks it): its
   * name, the text of each field a note can replace, and the fields its card lets agents change.
   */
  Rpc.make("AgentCards", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      entityIds: Schema.Array(EntityId),
      bindings: CardBindings
    },
    success: Schema.Array(
      Schema.Struct({
        entityId: EntityId,
        name: Schema.String,
        fields: Schema.Record(Schema.String, Schema.String),
        editableFields: Schema.Array(Schema.String)
      })
    ),
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("LookupLore", {
    payload: {
      userId: UserId,
      rolloutId: Schema.String,
      query: Schema.NullOr(Schema.String),
      entry: Schema.NullOr(Schema.String),
      limit: Schema.Int
    },
    success: Schema.Struct({
      books: Schema.Int,
      entries: Schema.Array(
        Schema.Struct({
          book: Schema.String,
          uid: Schema.Int,
          title: Schema.String,
          keys: Schema.Array(Schema.String),
          content: Schema.String
        })
      )
    }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A saved chat-state call result, checked before a resume revalidates already-applied state. */
  Rpc.make("RolloutReceipt", {
    payload: { userId: UserId, rolloutId: Schema.String, toolCallId: Schema.String },
    success: Schema.NullOr(Schema.String),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * What resuming an agent reply needs of its run (agentReads.ts): the rollout, its status and
   * mode, the frozen snapshot and the transcript as last saved, and the version's own status.
   */
  Rpc.make("RolloutMaterial", {
    payload: { userId: UserId, versionId: VersionId },
    success: Schema.Struct({
      rolloutId: Schema.String,
      status: Schema.String,
      versionStatus: Schema.String,
      mode: Schema.NullOr(Schema.String),
      snapshot: Schema.String,
      transcript: Schema.NullOr(Schema.String)
    }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** An agent reply's transcript after its request, verbatim, with its offered tools (agentReads.ts). */
  Rpc.make("RolloutTranscript", {
    payload: { userId: UserId, versionId: VersionId },
    success: RunTranscript,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** A chat's model work that made no message, from the ledger, newest first (agentReads.ts). */
  Rpc.make("ListActivity", {
    payload: { userId: UserId, chatId: ChatId, before: Schema.optionalKey(ActivityCursor), limit: Schema.Int },
    success: ActivityPage,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** Generation time and tokens of the user's versions (inspectorReads.ts); others are left out. */
  Rpc.make("VersionMetrics", {
    payload: { userId: UserId, versionIds: Schema.Array(VersionId) },
    success: Schema.Array(VersionMetrics),
    error: StorageError
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
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      leafSlotId: Schema.NullOr(SlotId)
    },
    success: LcmSettingsView,
    error: Schema.Union([NotFound, StorageError])
  }),
  Rpc.make("CacheWarmth", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      leafSlotId: Schema.optionalKey(Schema.NullOr(SlotId))
    },
    /** With the images to count off the hot path (`chat/ImageTokenCounts.ts`), never published. */
    success: Schema.Struct({
      ...NextContext.fields,
      uncounted: Schema.optionalKey(
        Schema.Struct({
          connectionId: Schema.String,
          kind: Schema.String,
          modelKey: Schema.String,
          detail: Schema.String,
          images: Schema.Array(Schema.Struct({ mediaId: Schema.String, sha256: Sha256 }))
        })
      )
    }),
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * NotFound when `CacheWarmth` would refuse the caller outright: the chat isn't theirs, or
   * the leaf or fork isn't in it. A cheap check, so a refusal never waits on the chat's reply.
   */
  Rpc.make("NextContextAccess", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      leafSlotId: Schema.optionalKey(Schema.NullOr(SlotId))
    },
    success: Schema.Void,
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The user's generation defaults; one naming something gone reads as none. */
  Rpc.make("GetGenerationDefaults", {
    payload: { userId: UserId },
    success: GenerationDefaults,
    error: StorageError
  }),
  /** The user's live connections that count through a provider, and whose (`tokenCounting.ts`). */
  Rpc.make("GetTextCalibration", {
    payload: { userId: UserId, connectionId: ConnectionId, modelKey: Schema.String, tokenizer: Schema.String },
    success: Schema.NullOr(Schema.Struct({ ratio: Schema.Number, samples: Schema.Int })),
    error: Schema.Union([StorageError, NotFound])
  }),
  Rpc.make("GetTokenCounting", {
    payload: { userId: UserId },
    success: Schema.Array(TokenCountingChoice),
    error: StorageError
  }),
  /** The user's decision settings whose connections are live (db/decisions.ts). */
  Rpc.make("GetDecisionSettings", {
    payload: { userId: UserId },
    success: Schema.Array(ConnectionDecisions),
    error: StorageError
  }),
  /** The user's live presets whose HEAD document lists the lorebook `ref` (`PresetDoc.lorebooks`). */
  Rpc.make("LorebookPresets", {
    payload: { userId: UserId, ref: RefId },
    success: Schema.Array(LorebookPreset),
    error: StorageError
  }),
  Rpc.make("GetGlobalRegex", { payload: { userId: UserId }, success: GlobalRegex, error: StorageError }),
  /** A version's text, reasoning and reply sections from before regex scripts rewrote them (null: unchanged). */
  Rpc.make("RawVersionText", {
    payload: { userId: UserId, versionId: VersionId },
    success: RawText,
    error: Schema.Union([NotFound, StorageError])
  }),
  /**
   * A generating reply's text so far through the scripts its finish runs (`RewriteText` at
   * the version, not an edit), for what's shown while it streams (ARCHITECTURE §12, "Live
   * rewrites"). Each worker prepares the scripts once per reply; every call has the time and
   * output of one rewrite.
   */
  Rpc.make("RewriteLive", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      slotId: SlotId,
      versionId: VersionId,
      items: Schema.Array(Schema.Struct({ text: Schema.String, kind: Schema.Literals(["message", "reasoning"]) }))
    },
    /**
     * `active`: whether any script or rewrite can change the text; without one, `texts` is
     * empty. `ms`: how long the rewrites took, in the worker.
     */
    success: Schema.Struct({ active: Schema.Boolean, texts: Schema.Array(TextRewrite), ms: Schema.Number }),
    error: Schema.Union([NotFound, AssemblyFailed, StorageError])
  }),
  /**
   * Regex scripts rewriting text before it's written (ARCHITECTURE §12, "Rewrites"): the
   * assembler's stages up to `scripts` for the position, then the registered rewrites.
   * `at`: an existing version (a reply finishing, an edit), or the next message after a leaf
   * (a send), written as `speakerEntityId`. `edit`: only scripts that run on edits.
   */
  Rpc.make("RewriteText", {
    payload: {
      userId: UserId,
      chatId: ChatId,
      forkId: Schema.optionalKey(Schema.NullOr(ForkId)),
      at: Schema.Union([
        Schema.Struct({ slotId: SlotId, versionId: VersionId }),
        Schema.Struct({ leafSlotId: Schema.NullOr(SlotId), speakerEntityId: Schema.NullOr(EntityId) })
      ]),
      edit: Schema.Boolean,
      items: Schema.Array(Schema.Struct({ text: Schema.String, kind: Schema.Literals(["message", "reasoning"]) }))
    },
    success: Schema.Array(TextRewrite),
    error: Schema.Union([NotFound, AssemblyFailed, StorageError])
  }),
  /** What the preset the user's chats use does with a card's own prompts (DESIGN §5.0). */
  Rpc.make("GetCardPromptUse", { payload: { userId: UserId }, success: CardPromptUse, error: StorageError }),
  /** The user's display choices; the defaults where none are stored. */
  Rpc.make("GetDisplayPrefs", { payload: { userId: UserId }, success: DisplayPrefs, error: StorageError }),
  /** The account's card-source choices and recently viewed cards; the defaults where none are stored. */
  Rpc.make("GetSourcePrefs", { payload: { userId: UserId }, success: SourcePrefs, error: StorageError }),
  /**
   * Which of a page of a source's cards the user already has (spec/CARD-SOURCES.md §3.7): by
   * the origin an adoption recorded, else by the same file imported from disk (its SHA-256,
   * when the source's version id is one). Live cards only; archived ones count.
   */
  /** Every draft of a source's card's fields (`remote_card`, `<source>:<remote>`), ended ones too, as `OpenEditor` lists a ref's. */
  Rpc.make("RemoteCardDrafts", {
    payload: { userId: UserId, targetId: Schema.String },
    success: Schema.Array(Draft),
    error: StorageError
  }),
  Rpc.make("HeldRemoteCards", {
    payload: {
      userId: UserId,
      sourceId: Schema.String,
      items: Schema.Array(Schema.Struct({ remoteId: Schema.String, sha256: Schema.NullOr(Schema.String) })).check(
        Schema.isMaxLength(200)
      )
    },
    success: Schema.Array(
      Schema.Struct({
        remoteId: Schema.String,
        entityId: EntityId,
        refId: RefId,
        archived: Schema.Boolean,
        /** The source's version the user has; for a card found by its file's hash, that hash. */
        remoteVersion: Schema.NullOr(Schema.String),
        /** The newest version the source reported, when it isn't that one. */
        seenVersion: Schema.NullOr(Schema.String),
        /** Found by its origin row, which records versions (not by its file's hash). */
        tracked: Schema.Boolean
      })
    ),
    error: StorageError
  }),
  /** A live card's origin, when it was added from a card source; never contacts the source. */
  Rpc.make("CardOrigin", {
    payload: { userId: UserId, entityId: EntityId },
    success: Schema.NullOr(
      Schema.Struct({
        sourceId: Schema.String,
        remoteId: Schema.String,
        remoteVersion: Schema.String,
        seenVersion: Schema.NullOr(Schema.String)
      })
    ),
    error: StorageError
  }),
  // --- Branches (DESIGN §3.2) and forks.
  /** The live forks of a chat of the user's, most recently current first. */
  Rpc.make("ListForks", {
    payload: { userId: UserId, chatId: ChatId },
    success: Schema.Array(Fork),
    error: Schema.Union([NotFound, StorageError])
  }),
  /** The alternates at a live slot's place, as SwitchBranch counts them, oldest first, with names. */
  Rpc.make("ListBranches", {
    payload: { userId: UserId, slotId: SlotId, forkId: Schema.optionalKey(Schema.NullOr(ForkId)) },
    success: Schema.Array(Branch),
    error: Schema.Union([NotFound, StorageError])
  })
) {}
