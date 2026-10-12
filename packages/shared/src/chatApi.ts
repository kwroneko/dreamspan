// The chat RPCs (DESIGN §3, DATA-MODEL §4), merged into AppApi. Writes that change a
// selection or a text carry the row version the client saw (StaleWrite otherwise); a new
// message names the tip it was written under (LeafMoved otherwise).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem } from "./bin.ts"
import { Chat, ChatId, PathEntry, SlotId, Version, VersionId } from "./chat.ts"
import { LeafMoved, NotFound, ServerError, StaleWrite } from "./errors.ts"

/** Generation needs a generator, and none is configured (the context assembler isn't built yet). */
export class GenerationUnavailable extends Schema.TaggedError<GenerationUnavailable>()("GenerationUnavailable", {
  message: Schema.String
}) {}

/**
 * A message onto a message still being generated. Provisional: whether such a message
 * should queue or cancel the reply is an open decision (DESIGN §2.2); until it's made,
 * the server refuses it, as the client's disabled Send does.
 */
export class ChatBusy extends Schema.TaggedError<ChatBusy>()("ChatBusy", {
  chatId: Schema.String,
  versionId: Schema.String
}) {}

/** Only a finished user-written version is amended in place; others get a new version (DESIGN §3.1). */
export class NotAmendable extends Schema.TaggedError<NotAmendable>()("NotAmendable", {
  versionId: Schema.String
}) {}

/** The largest window one ReadPath returns. */
const MAX_WINDOW = 500

/**
 * Which part of a path to read. `Older` and `Newer` continue from a window's cursors:
 * `Older` reads the window ending at `from` (inclusive), `Newer` the one starting below
 * `after`. `Around` opens at a slot, about half the window on each side.
 */
export const PathRange = Schema.Union([
  Schema.TaggedStruct("Bottom", {}),
  Schema.TaggedStruct("Older", { from: SlotId }),
  Schema.TaggedStruct("Newer", { after: SlotId }),
  Schema.TaggedStruct("Around", { slot: SlotId })
])
export type PathRange = typeof PathRange.Type

/**
 * A window of a path, root to leaf order. Deleted messages are walked through but not
 * returned, so a window can be short or empty while the cursors still move on.
 */
export class PathWindow extends Schema.Class<PathWindow>("PathWindow")({
  /**
   * The path's leaf. For `Around` a slot that isn't on the asked path opens the path
   * through it instead, continuing on its latest replies, and this says which.
   */
  leafSlotId: Schema.NullOr(SlotId),
  entries: Schema.Array(PathEntry),
  /** Where the next older window ends; null at the root. */
  older: Schema.NullOr(SlotId),
  /** Where the next newer window starts below; null at the leaf. */
  newer: Schema.NullOr(SlotId)
}) {}

/** Pushed to a chat's subscribers. Streamed text comes as deltas, never as whole messages. */
export const ChatEvent = Schema.Union([
  /** The first event of every subscription, with the text so far of each version generating now. */
  Schema.TaggedStruct("Hello", {
    live: Schema.Array(Schema.Struct({ versionId: VersionId, text: Schema.String }))
  }),
  /** Text appended to a generating version at `offset`, so a client can tell a repeat from a gap. */
  Schema.TaggedStruct("Delta", { versionId: VersionId, offset: Schema.Int, text: Schema.String }),
  /** A slot was added, or its selection or versions changed. */
  Schema.TaggedStruct("Slot", { entry: PathEntry }),
  /** A version's text or status changed: a generation ended, or it was amended. */
  Schema.TaggedStruct("Version", { version: Version }),
  /** The chat changed: its active leaf, title or last message. */
  Schema.TaggedStruct("Chat", { chat: Chat }),
  /** Something was deleted: windows read before it are out of date. */
  Schema.TaggedStruct("Reload", {}),
  /** The chat went to the bin. It's the subscription's last event. */
  Schema.TaggedStruct("Deleted", {})
])
export type ChatEvent = typeof ChatEvent.Type

const Errors = [NotFound, ServerError] as const
const WriteErrors = [NotFound, StaleWrite, ServerError] as const

/** A message added to a chat, and the chat after it. */
const Appended = Schema.Struct({ entry: PathEntry, chat: Chat })

export class ChatApi extends RpcGroup.make(
  /** The user's chats, most recent first. `before` is the last chat of the previous page. */
  Rpc.make("ListChats", {
    payload: {
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
      before: Schema.NullOr(Schema.Struct({ at: Schema.Number, id: ChatId }))
    },
    success: Schema.Array(Chat),
    error: ServerError
  }),
  Rpc.make("CreateChat", { payload: { title: Schema.String }, success: Chat, error: ServerError }),
  Rpc.make("GetChat", { payload: { chatId: ChatId }, success: Chat, error: Schema.Union([...Errors]) }),
  /** A window of the path ending at `leafSlotId` (null: the chat's active leaf). */
  Rpc.make("ReadPath", {
    payload: {
      chatId: ChatId,
      leafSlotId: Schema.NullOr(SlotId),
      range: PathRange,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WINDOW }))
    },
    success: PathWindow,
    error: Schema.Union([...Errors])
  }),
  /** A slot's versions, for the version picker. */
  Rpc.make("ListVersions", {
    payload: { slotId: SlotId },
    success: Schema.Array(Version),
    error: Schema.Union([...Errors])
  }),
  /**
   * The user's message under `parentSlotId`. Without `branch`, that must be the chat's
   * active leaf (LeafMoved otherwise); with it, any slot, starting a branch (DESIGN §3.2).
   */
  Rpc.make("SendMessage", {
    payload: { chatId: ChatId, parentSlotId: Schema.NullOr(SlotId), branch: Schema.Boolean, content: Schema.String },
    success: Appended,
    error: Schema.Union([NotFound, LeafMoved, ChatBusy, ServerError])
  }),
  /** A model reply under `parentSlotId`, streamed to subscribers; `branch` as for SendMessage. */
  Rpc.make("Generate", {
    payload: { chatId: ChatId, parentSlotId: Schema.NullOr(SlotId), branch: Schema.Boolean },
    success: Appended,
    error: Schema.Union([NotFound, LeafMoved, GenerationUnavailable, ServerError])
  }),
  /** A swipe: a new model version of a slot, selected and streamed. Several can run at once. */
  Rpc.make("Regenerate", {
    payload: { slotId: SlotId, expectedRowVersion: Schema.Int },
    success: PathEntry,
    error: Schema.Union([...WriteErrors, GenerationUnavailable])
  }),
  /** Stops one generation; its text so far is kept. Returns the stopped version. */
  Rpc.make("StopGeneration", { payload: { versionId: VersionId }, success: Version, error: Schema.Union([...Errors]) }),
  Rpc.make("SelectVersion", {
    payload: { slotId: SlotId, versionId: VersionId, expectedRowVersion: Schema.Int },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  /** An edit saved as a new version, "edited from" its source (DESIGN §3.1), and selected. */
  Rpc.make("EditVersion", {
    payload: { slotId: SlotId, sourceVersionId: VersionId, content: Schema.String, expectedRowVersion: Schema.Int },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  /** "Write your own version" of any message, selected. */
  Rpc.make("WriteVersion", {
    payload: { slotId: SlotId, content: Schema.String, expectedRowVersion: Schema.Int },
    success: PathEntry,
    error: Schema.Union([...WriteErrors])
  }),
  /** Changes a user-written version in place; its earlier text is kept in its history. */
  Rpc.make("AmendVersion", {
    payload: { versionId: VersionId, content: Schema.String, expectedRowVersion: Schema.Int },
    success: Version,
    error: Schema.Union([...WriteErrors, NotAmendable])
  }),
  // --- Deleting goes to the recycle bin (ARCHITECTURE §3.11); generations under what was
  // deleted are stopped.
  Rpc.make("DeleteChat", { payload: { chatId: ChatId }, success: BinItem, error: Schema.Union([...Errors]) }),
  Rpc.make("DeleteMessage", { payload: { slotId: SlotId }, success: BinItem, error: Schema.Union([...Errors]) }),
  Rpc.make("DeleteBranch", { payload: { slotId: SlotId }, success: BinItem, error: Schema.Union([...Errors]) }),
  Rpc.make("DeleteVersion", { payload: { versionId: VersionId }, success: BinItem, error: Schema.Union([...Errors]) }),
  /**
   * Live updates to one chat. Each element is a batch, coalesced on the server per frame
   * (about 16 ms). The first batch starts with Hello.
   */
  Rpc.make("SubscribeChat", {
    payload: { chatId: ChatId },
    success: Schema.Array(ChatEvent),
    error: Schema.Union([...Errors]),
    stream: true
  })
) {}
