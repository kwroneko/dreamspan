// Inserting a message anywhere in a fork's history (spec/MESSAGE-INSERT.md; owner decision
// DESIGN §3.1, 2026-10-30): the RPC, merged into AppApi. The server dispatches it through the
// registered command `message.insert` (api/messages.ts), so anything that runs commands, the
// in-app agent included, inserts messages the same way.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Chat, ChatId, EntityId, ForkId, MessageImages, PathEntry, SlotId, VersionId } from "./chat.ts"
import { GenerationUnavailable } from "./chatApi.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { HistoryRejected } from "./historyApi.ts"

/**
 * The insertion editor's draft (`insertDraftKey`) the text was typed into: committed in the same
 * transaction only if it still holds exactly that text (the content, or Generate's direction).
 */
const InsertDraft = Schema.optionalKey(Schema.Struct({ draftId: Schema.String, session: Schema.Int }))

/**
 * What is inserted: text written as a speaker (null: no card, as the composer allows), a
 * turn the model writes as a speaker at that point (`direction`: the one-turn direction, as
 * the composer's Generate X takes it), or a copy of the version the fork shows at the anchor.
 */
export const InsertBody = Schema.Union([
  Schema.TaggedStruct("Write", {
    speaker: Schema.NullOr(EntityId),
    content: Schema.String,
    images: Schema.optionalKey(MessageImages),
    draft: InsertDraft
  }),
  Schema.TaggedStruct("Generate", {
    speaker: Schema.NullOr(EntityId),
    direction: Schema.optionalKey(Schema.String),
    draft: InsertDraft
  }),
  Schema.TaggedStruct("Duplicate", { versionId: VersionId })
])
export type InsertBody = typeof InsertBody.Type

/** A version that can't be copied: still generating, or failed. */
export class InsertRefused extends Schema.TaggedError<InsertRefused>()("InsertRefused", {
  message: Schema.String
}) {}

/**
 * The input of `message.insert`: a message below `anchor` (null: above the first message)
 * in fork `forkId`, whose row version as the tab saw it is `expectedRowVersion`.
 */
export const InsertMessageInput = Schema.Struct({
  chatId: ChatId,
  forkId: ForkId,
  anchor: Schema.NullOr(SlotId),
  expectedRowVersion: Schema.Int,
  body: InsertBody
})
export type InsertMessageInput = typeof InsertMessageInput.Type

/** The inserted message as its fork shows it, with its position on the fork's display path. */
export class InsertedMessage extends Schema.Class<InsertedMessage>("InsertedMessage")({
  entry: PathEntry,
  chat: Chat
}) {}

/**
 * Where a fork shows a slot, as a move left it: after `anchor` (null: above the first message),
 * or at its own place (null). `seq` orders it among the slots moved after the same anchor.
 */
const MovePlace = Schema.NullOr(Schema.Struct({ anchor: Schema.NullOr(SlotId), seq: Schema.optionalKey(Schema.Int) }))

/** One slot a move placed: where the fork showed it before and after. Undo writes `before` back. */
export const MoveStep = Schema.Struct({ slotId: SlotId, before: MovePlace, after: MovePlace })
export type MoveStep = typeof MoveStep.Type

/**
 * The input of `message.move` (owner, 2026-11-16): message `slotId` one shown message up or
 * down in fork `forkId`, in that fork only. `expectedRowVersion` is the slot's as the tab saw it.
 */
export const MoveMessageInput = Schema.Struct({
  chatId: ChatId,
  forkId: ForkId,
  slotId: SlotId,
  direction: Schema.Literals(["up", "down"]),
  expectedRowVersion: Schema.Int,
  /**
   * The shown message the tab would swap it with. When the fork shows another one there now (a
   * move from another tab), the move is refused with `StaleWrite` and the tab reloads, instead
   * of moving it one step past what the tab showed. Absent: not checked (the neighbour isn't
   * loaded in the tab).
   */
  expectedNeighbourId: Schema.optionalKey(SlotId)
})
export type MoveMessageInput = typeof MoveMessageInput.Type

/** A move's result: the moved message's new position, and what Undo writes back. */
export class MovedMessage extends Schema.Class<MovedMessage>("MovedMessage")({
  slotId: SlotId,
  forkId: ForkId,
  position: Schema.Int,
  undo: Schema.Array(MoveStep),
  chat: Chat
}) {}

/** The input of `message.move.undo`: a move's steps, undone while nothing changed them since. */
export const UndoMoveInput = Schema.Struct({ chatId: ChatId, forkId: ForkId, undo: Schema.Array(MoveStep) })
export type UndoMoveInput = typeof UndoMoveInput.Type

/** A message that can't move that way: it's the first (up) or last (down) shown message. */
export class MoveRefused extends Schema.TaggedError<MoveRefused>()("MoveRefused", {
  message: Schema.String
}) {}

export const MessagesApi = RpcGroup.make(
  /**
   * Inserts a message directly below `anchor`, whatever was inserted there before. The anchor
   * must be shown and not deleted in the fork (StaleWrite otherwise); a neighbour inserted
   * meanwhile is no conflict. A generated one streams in place like a swipe, from the fork's
   * display path up to the anchor: the model never sees what follows (DESIGN §3.1). The fork
   * becomes current, and subscribers get the slot as `Slot`, with its position.
   */
  Rpc.make("InsertMessage", {
    payload: InsertMessageInput,
    success: InsertedMessage,
    error: Schema.Union([NotFound, StaleWrite, InsertRefused, GenerationUnavailable, HistoryRejected, ServerError])
  })
)

/** Moving messages: a group of its own, merged into AppApi beside AppCoreApi. */
export const MoveApi = RpcGroup.make(
  /**
   * Moves a message one shown message up or down in a fork (owner, 2026-11-16): later replies
   * there see it in its new place; other forks keep their order. Summaries over the old order
   * are marked stale there. `UndoMoveMessage` takes the result's `undo` back.
   */
  Rpc.make("MoveMessage", {
    payload: MoveMessageInput,
    success: MovedMessage,
    error: Schema.Union([NotFound, StaleWrite, MoveRefused, HistoryRejected, ServerError])
  }),
  /** Undoes a move while its slots are still where it put them (StaleWrite otherwise). */
  Rpc.make("UndoMoveMessage", {
    payload: UndoMoveInput,
    success: Chat,
    error: Schema.Union([NotFound, StaleWrite, HistoryRejected, ServerError])
  })
)
