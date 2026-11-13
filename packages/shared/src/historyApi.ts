import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, ForkId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

export class HistoryRejected extends Schema.TaggedError<HistoryRejected>()("HistoryRejected", {
  message: Schema.String
}) {}
const boundedText = Schema.String.check(Schema.isMaxLength(2_000_000))
const FindPair = Schema.Struct({
  find: Schema.String.check(Schema.isMaxLength(2000)),
  replace: Schema.String.check(Schema.isMaxLength(10000))
})
export const HistorySearch = Schema.Struct({
  pairs: Schema.Array(FindPair).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  matchCase: Schema.Boolean,
  wholeWord: Schema.Boolean,
  regex: Schema.Boolean,
  preserveCase: Schema.Boolean,
  messages: Schema.Boolean,
  swipes: Schema.Boolean,
  summaries: Schema.Boolean
})
export type HistorySearch = typeof HistorySearch.Type
export const HistoryEdit = Schema.Struct({
  kind: Schema.Literals(["version_replace", "summary_revision", "state_event"]),
  targetId: Schema.String,
  beforeId: Schema.String,
  before: boundedText,
  after: boundedText,
  /** New state events can begin at the current message. */
  atSlotId: Schema.optionalKey(Schema.String)
})
export type HistoryEdit = typeof HistoryEdit.Type
const HistoryMatch = Schema.Struct({ start: Schema.Int, end: Schema.Int, replacement: Schema.String })
export const HistoryHit = Schema.Struct({
  ...HistoryEdit.fields,
  seq: Schema.optionalKey(Schema.Int),
  slotId: Schema.String,
  depth: Schema.Int,
  toDepth: Schema.Int,
  level: Schema.Int,
  selected: Schema.Boolean,
  matches: Schema.Array(HistoryMatch)
})
export type HistoryHit = typeof HistoryHit.Type
export const HistoryCursor = Schema.Struct({
  depth: Schema.optionalKey(Schema.Int),
  kind: Schema.Literals(["version_replace", "summary_revision"]),
  seq: Schema.Int
})
const HistoryPreview = Schema.Struct({
  hits: Schema.Array(HistoryHit),
  next: Schema.NullOr(HistoryCursor),
  /** All summaries searched on this page, including ones without a matching passage. */
  summaryIds: Schema.optionalKey(Schema.Array(Schema.String))
})
const HistoryApplication = Schema.Struct({
  chatId: ChatId,
  forkId: ForkId,
  summariesIncluded: Schema.optionalKey(Schema.Boolean),
  /** When present, preserve inputs only for these searched summaries. Omitted by all-view renames. */
  summaryIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(10000))),
  edits: Schema.Array(HistoryEdit).check(Schema.isMaxLength(10000))
})
const HistoryItem = Schema.Struct({
  id: Schema.Int,
  ...HistoryEdit.fields,
  seq: Schema.optionalKey(Schema.Int),
  slotId: Schema.NullOr(Schema.String),
  applied: Schema.Boolean
})
export const HistoryRecord = Schema.Struct({
  id: Schema.String,
  groupId: Schema.NullOr(Schema.String),
  title: Schema.String,
  createdAt: Schema.Number,
  madeIn: Schema.String,
  madeInName: Schema.String,
  inherited: Schema.Boolean,
  status: Schema.Literals(["applied", "partly undone", "undone"]),
  items: Schema.Array(HistoryItem),
  workshop: Schema.optionalKey(
    Schema.Struct({
      chatId: ChatId,
      name: Schema.String,
      versionId: Schema.NullOr(Schema.String),
      slotId: Schema.NullOr(Schema.String),
      toolCallId: Schema.String
    })
  )
})
const HistoryTarget = Schema.Struct({ chatId: ChatId, forkId: ForkId })
export const historyReadRpcs = [
  Rpc.make("PreviewHistory", {
    payload: {
      chatId: ChatId,
      forkId: ForkId,
      search: HistorySearch,
      cursor: Schema.optionalKey(HistoryCursor),
      /**
       * In a chat set to separate contexts, a character whose own summaries to search too
       * (spec/CHARACTER-CONTEXT.md §2.3, unit C7). Absent: the shared summaries only.
       */
      viewer: Schema.optionalKey(EntityId),
      trackSummaries: Schema.optionalKey(Schema.Boolean)
    },
    success: HistoryPreview,
    error: Schema.Union([NotFound, HistoryRejected, ServerError])
  }),
  Rpc.make("ListHistoryEdits", {
    payload: { chatId: ChatId, forkId: ForkId },
    success: Schema.Array(HistoryRecord),
    error: Schema.Union([NotFound, HistoryRejected, ServerError])
  }),
  Rpc.make("HistoryEditCost", {
    payload: {
      chatId: ChatId,
      forkId: ForkId,
      fromDepth: Schema.Int,
      retainedDepth: Schema.Int,
      summaryIds: Schema.Array(Schema.String)
    },
    success: Schema.Struct({ messages: Schema.Int, summaries: Schema.Int, tokens: Schema.Int }),
    error: Schema.Union([NotFound, HistoryRejected, ServerError])
  }),
  Rpc.make("RenameHistoryTargets", {
    payload: { entityId: EntityId },
    success: Schema.Array(HistoryTarget),
    error: Schema.Union([NotFound, HistoryRejected, ServerError])
  })
] as const
export const historyWriteRpcs = [
  Rpc.make("ApplyHistoryEdits", {
    payload: {
      title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      groupId: Schema.optionalKey(Schema.String),
      applications: Schema.Array(HistoryApplication).check(Schema.isMinLength(1), Schema.isMaxLength(1000))
    },
    success: Schema.Struct({ groupId: Schema.String, changesetIds: Schema.Array(Schema.String) }),
    error: Schema.Union([NotFound, HistoryRejected, ServerError])
  }),
  Rpc.make("UndoHistoryEdit", {
    payload: {
      chatId: ChatId,
      forkId: ForkId,
      changesetId: Schema.String,
      slotId: Schema.optionalKey(Schema.String),
      itemIds: Schema.optionalKey(Schema.Array(Schema.Int))
    },
    success: Schema.Struct({ undone: Schema.Int, conflicts: Schema.Array(Schema.Int) }),
    error: Schema.Union([NotFound, HistoryRejected, ServerError])
  })
] as const
export const RenameHistoryInput = Schema.Struct({
  entityId: EntityId,
  oldName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  newName: Schema.String.check(Schema.isMaxLength(10000)),
  scope: Schema.Literals(["none", "this", "all"]),
  chatId: ChatId,
  forkId: ForkId
})

export const HistoryApi = RpcGroup.make(
  ...historyReadRpcs,
  ...historyWriteRpcs,
  Rpc.make("RenameHistory", {
    payload: RenameHistoryInput,
    success: Schema.Int,
    error: Schema.Union([NotFound, HistoryRejected, ServerError])
  })
)
