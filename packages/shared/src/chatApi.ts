// The chat RPCs (DESIGN §3, DATA-MODEL §4), merged into AppApi. Writes that change a
// selection or a text carry the row version the client saw (StaleWrite otherwise); a new
// message names the tip it was written under (LeafMoved otherwise).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem } from "./bin.ts"
import { Chat, ChatId, EntityId, PathEntry, QueuedMessage, SlotId, Version, VersionId } from "./chat.ts"
import { LeafMoved, NotFound, ServerError, StaleWrite } from "./errors.ts"
import { Draft } from "./drafts.ts"

/** Generation needs a generator, and this server has none (only tests run one without). */
export class GenerationUnavailable extends Schema.TaggedError<GenerationUnavailable>()("GenerationUnavailable", {
  message: Schema.String
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
  Schema.TaggedStruct("Deleted", {}),
  /** The chat's send queue changed: every entry still waiting, in order. */
  Schema.TaggedStruct("Queue", { queue: Schema.Array(QueuedMessage) }),
  /** Chat state changed (participants, presence, settings): read it again. */
  Schema.TaggedStruct("State", {})
])
export type ChatEvent = typeof ChatEvent.Type

const Errors = [NotFound, ServerError] as const
const WriteErrors = [NotFound, StaleWrite, ServerError] as const

/**
 * The row version of the composer draft at the tip (composerApi.ts) the text was typed in:
 * the draft is committed in the same transaction as the send, unless another tab typed on
 * since, so a reload never shows text already sent (DESIGN §6.2).
 */
const ComposerRowVersion = Schema.optionalKey(Schema.Int)

/** Where a branch switch went: the sibling, and the chat with its leaf moved below it. */
export class BranchSwitch extends Schema.Class<BranchSwitch>("BranchSwitch")({
  slotId: SlotId,
  chat: Chat
}) {}

/**
 * The composer draft the text came from after the send: committed, or still active with
 * another tab's newer text (§3.10); null without `composerRowVersion`.
 */
const SentDraft = Schema.NullOr(Draft)

/**
 * What a send or a Generate did: posted at once, or queued behind a reply still being
 * written (DESIGN §2.2), with every entry now waiting in the chat.
 */
export const SendResult = Schema.Union([
  Schema.TaggedStruct("Posted", { entry: PathEntry, chat: Chat, draft: SentDraft }),
  Schema.TaggedStruct("Queued", { queued: QueuedMessage, queue: Schema.Array(QueuedMessage), draft: SentDraft })
])
export type SendResult = typeof SendResult.Type

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
   * The user's message under `parentSlotId`, as `speakerEntityId` (Send as X). Without
   * `branch`, that must be the chat's active leaf (LeafMoved otherwise); with it, any slot,
   * starting a branch (DESIGN §3.2). Onto a reply still being written, it's queued and
   * posts when that reply ends (DESIGN §2.2), followed by a reply of its own.
   */
  Rpc.make("SendMessage", {
    payload: {
      chatId: ChatId,
      parentSlotId: Schema.NullOr(SlotId),
      branch: Schema.Boolean,
      content: Schema.String,
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      /**
       * Who replies to it, if it's queued: the reply then starts on the server, as the client
       * would have asked for it after an immediate send.
       */
      replySpeakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      composerRowVersion: ComposerRowVersion
    },
    success: SendResult,
    error: Schema.Union([NotFound, LeafMoved, ServerError])
  }),
  /**
   * A model reply under `parentSlotId`, as `speakerEntityId` (Generate X), streamed to
   * subscribers; `branch` as for SendMessage. `direction` is a one-turn direction stored on
   * the reply: its swipes reuse it, later turns never see it. Onto a reply still being
   * written, it's queued like a message.
   */
  Rpc.make("Generate", {
    payload: {
      chatId: ChatId,
      parentSlotId: Schema.NullOr(SlotId),
      branch: Schema.Boolean,
      speakerEntityId: Schema.optionalKey(Schema.NullOr(EntityId)),
      direction: Schema.optionalKey(Schema.String),
      composerRowVersion: ComposerRowVersion
    },
    success: SendResult,
    error: Schema.Union([NotFound, LeafMoved, GenerationUnavailable, ServerError])
  }),
  /**
   * A swipe: a new model version of a slot, selected and streamed, with the speaker and
   * the one-turn direction of the version it replaces. Several can run at once.
   */
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
   * Switches to the branch at `index` (0: the oldest) among the alternates at `slotId`
   * (DESIGN §3.2): the chat's active leaf moves to the tip below that sibling, following its
   * newest replies. The composer stays where it was: each branch has its own.
   */
  Rpc.make("SwitchBranch", {
    payload: { chatId: ChatId, slotId: SlotId, index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
    success: BranchSwitch,
    error: Schema.Union([...WriteErrors])
  }),
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
