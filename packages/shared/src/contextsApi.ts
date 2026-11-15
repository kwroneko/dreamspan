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

/**
 * A recorded state change on a branch's path, as the timeline's change markers read it
 * (client `features/chat/stateMarkers.ts`): the event as stored, where it was written
 * (`slotId` null: before the first message) and what wrote it.
 */
export const StateMarkEvent = Schema.Struct({
  eventId: Schema.String,
  slotId: Schema.NullOr(SlotId),
  /** Set while the event belongs to one version of its message: it applies while that one is shown. */
  versionId: Schema.NullOr(Schema.String),
  origin: Schema.String,
  scope: Schema.NullOr(Schema.String),
  key: Schema.String,
  value: Schema.Unknown
})
export type StateMarkEvent = typeof StateMarkEvent.Type

/** A note an event names: whose it is and how it stands without a switch. */
const StateMarkNote = Schema.Struct({
  card: Schema.NullOr(Schema.String),
  onByDefault: Schema.Boolean,
  /** Notes moved out of one card field switch together. */
  group: Schema.NullOr(Schema.String)
})

export const StateMarks = Schema.Struct({
  /** In fold order: before the first message, then each message of the path, as shown. */
  events: Schema.Array(StateMarkEvent),
  /** The names of the cards, notes, presets, lorebooks, models and connections the events name, by id. */
  names: Schema.Record(Schema.String, Schema.String),
  notes: Schema.Record(Schema.String, StateMarkNote)
})
export type StateMarks = typeof StateMarks.Type

/** Bounded request size, with room for the union of installed marker kinds' keys. */
const MAX_STATE_MARK_KEYS = 4096
const StateMarkKeys = Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
  Schema.isMaxLength(MAX_STATE_MARK_KEYS)
)

export class ChatContextsApi extends RpcGroup.make(
  /**
   * The state events of the named keys on the fork's path through `slotId` (the leaf shown),
   * with the names of what they name: one read a branch, for every change marker on screen.
   */
  Rpc.make("GetStateMarks", {
    payload: { chatId: ChatId, forkId: ForkId, slotId: Schema.NullOr(SlotId), keys: StateMarkKeys },
    success: StateMarks,
    error: Schema.Union([NotFound, ServerError])
  }),
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
