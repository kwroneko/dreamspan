// Separate contexts per character in the app (spec/CHARACTER-CONTEXT.md §5, §9.2 unit CU3): the
// away marks on a branch's path, for the timeline's away rows, and Undo of a scene check's mark.
// A group of its own, as the split chats' and merges' are.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId, ForkId, SlotId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

/**
 * An away mark on a branch's path (`away.set`): where it was written, whom it's about, and who
 * set it: the scene check, a character's own reply (its tool; `setBy` is the reply's speaker) or
 * the user.
 */
export const AwayMark = Schema.Struct({
  eventId: Schema.String,
  slotId: SlotId,
  entityId: EntityId,
  away: Schema.Boolean,
  by: Schema.Literals(["decision", "character", "user"]),
  setBy: Schema.optionalKey(EntityId)
})
export type AwayMark = typeof AwayMark.Type

export class ChatContextsApi extends RpcGroup.make(
  /** The away marks on the fork's path through `slotId` (the leaf shown), in order. */
  Rpc.make("GetAwayMarks", {
    payload: { chatId: ChatId, forkId: ForkId, slotId: Schema.NullOr(SlotId) },
    success: Schema.Array(AwayMark),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Correct a scene check's departure or return only in this tab's branch, through its next
   * presence mark. Existing branches keep their marks and knowledge; later children inherit
   * this correction. False when the mark isn't the scene check's, or no longer applies.
   */
  Rpc.make("UndoAwayMark", {
    payload: { chatId: ChatId, forkId: ForkId, eventId: Schema.String },
    success: Schema.Boolean,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
