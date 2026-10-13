// Starting chats from cards, who's in them, their settings, and the send queue (DESIGN
// §2.1, §2.2, §3.5; DATA-MODEL §5.3), merged into AppApi. Every id is the caller's own;
// anything else is NotFound.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { CastCard, Chat, ChatId, EntityId, FrozenMacros, PathEntry, QueuedMessage, SlotId } from "./chat.ts"
import { GenerationUnavailable } from "./chatApi.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { Doc, LibraryRef, RefId } from "./library.ts"
import { ConnectionId, ModelId } from "./providers.ts"

/** A card's greetings and the fields its macros read, for a chat that isn't made yet. */
export class CardForChat extends Schema.Class<CardForChat>("CardForChat")({
  card: CastCard,
  /** `first_mes`, then the alternate greetings; empty ones left out. */
  greetings: Schema.Array(Schema.String),
  description: Schema.String,
  personality: Schema.String,
  scenario: Schema.String
}) {}

const CardsLayout = Schema.Literals(["concat", "swap_tail"])
const RolesProjection = Schema.Literals(["by_writer", "alternate", "perspective"])

/**
 * Who is in a chat, and its settings, at one position: the fold of its state events
 * (DATA-MODEL §5.2), with every card named there.
 */
export class Cast extends Schema.Class<Cast>("Cast")({
  /** The position: state after this slot (null: before the first message). */
  slotId: Schema.NullOr(SlotId),
  /** In join order. */
  participants: Schema.Array(EntityId),
  /** Participants marked absent (DESIGN §3.5). */
  absent: Schema.Array(EntityId),
  /** The "played by me" set: the composer's default speaker and `{{user}}` (DESIGN §2.2). */
  playedByMe: Schema.Array(EntityId),
  /** The chat-wide model and preset; the context assembler reads these. */
  model: Schema.NullOr(Schema.Struct({ connection: ConnectionId, model: ModelId })),
  preset: Schema.NullOr(RefId),
  lorebooks: Schema.Array(RefId),
  /** Cards whose own lorebook this chat has turned off. */
  cardLorebooksOff: Schema.Array(EntityId),
  layoutCards: Schema.NullOr(CardsLayout),
  rolesProjection: Schema.NullOr(RolesProjection),
  /** Every card named above. */
  cards: Schema.Array(CastCard)
}) {}

/** The first turn of a new chat: what turns a card's greeting into a chat. */
export const FirstTurn = Schema.Union([
  Schema.TaggedStruct("Send", { content: Schema.String, speakerEntityId: Schema.NullOr(EntityId) }),
  Schema.TaggedStruct("Generate", { speakerEntityId: Schema.NullOr(EntityId), direction: Schema.String })
])
export type FirstTurn = typeof FirstTurn.Type

/** A change to who's in a chat, or to its settings, from a position on. */
export const CastChange = Schema.Union([
  Schema.TaggedStruct("Join", { entityId: EntityId }),
  Schema.TaggedStruct("Leave", { entityId: EntityId }),
  Schema.TaggedStruct("Presence", { entityId: EntityId, present: Schema.Boolean }),
  Schema.TaggedStruct("PlayedByMe", { entityIds: Schema.Array(EntityId) }),
  Schema.TaggedStruct("Model", { connection: ConnectionId, model: ModelId }),
  Schema.TaggedStruct("Preset", { ref: RefId }),
  Schema.TaggedStruct("Layout", { layout: CardsLayout }),
  Schema.TaggedStruct("Roles", { projection: RolesProjection }),
  /** A note on or off (`note.activate`, `note.deactivate`): the chat's own, or a participant card's. */
  Schema.TaggedStruct("Lorebook", { ref: RefId, active: Schema.Boolean }),
  /** A card's own lorebook on or off (`lorebook.embedded`). */
  Schema.TaggedStruct("CardLorebook", { entityId: EntityId, on: Schema.Boolean }),
  Schema.TaggedStruct("Note", { entityId: EntityId, active: Schema.Boolean })
])
export type CastChange = typeof CastChange.Type

/**
 * A note a chat can use (DESIGN §4.1): the chat's own, or one of a participant card's, by its
 * upstream ref, and whether it's on at the position asked about.
 */
export class ChatNote extends Schema.Class<ChatNote>("ChatNote")({
  ref: LibraryRef,
  doc: Doc,
  /** The card whose note it is; null for the chat's own. */
  card: Schema.NullOr(EntityId),
  /** The card's first note, ST's Character's Note: on unless the chat turns it off. */
  first: Schema.Boolean,
  active: Schema.Boolean
}) {}

const Errors = [NotFound, ServerError] as const

export class ChatSetupApi extends RpcGroup.make(
  /** Every live card of the user's, by label: the speaker switcher's All cards and Personas. */
  Rpc.make("ListCards", { success: Schema.Array(CastCard), error: ServerError }),
  /** Puts a card in the persona folder, or takes it out (DESIGN §2.2). */
  Rpc.make("SetPersona", {
    payload: { entityId: EntityId, persona: Schema.Boolean },
    success: CastCard,
    error: Schema.Union([...Errors])
  }),
  /** A card's greetings, for showing it before any chat exists (DESIGN §2.1). */
  Rpc.make("GetCardForChat", {
    payload: { entityId: EntityId },
    success: CardForChat,
    error: Schema.Union([...Errors])
  }),
  /**
   * Makes a chat from cards on its first turn, never before (DESIGN §2.1): the cards and
   * the persona join at the start, the persona is played by the user, and every greeting
   * becomes a version of the first message (`greeting` selected). Then the first turn:
   * the user's message (the client asks for the reply, as after any send), or a reply.
   */
  Rpc.make("StartChat", {
    payload: {
      cards: Schema.Array(EntityId).check(Schema.isMinLength(1)),
      persona: Schema.NullOr(EntityId),
      greeting: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      first: FirstTurn,
      /**
       * What the picked greeting's random and time macros showed, kept so the chat shows it as
       * it was seen (DESIGN §5.6). The server freezes every greeting either way: it checks
       * these and draws whatever is missing.
       */
      frozen: Schema.optionalKey(FrozenMacros)
    },
    success: Schema.Struct({ entry: PathEntry, chat: Chat }),
    error: Schema.Union([...Errors, GenerationUnavailable])
  }),
  /** Who's in the chat, and its settings, after `slotId` (null: at the start). */
  Rpc.make("GetCast", {
    payload: { chatId: ChatId, slotId: Schema.NullOr(SlotId) },
    success: Cast,
    error: Schema.Union([...Errors])
  }),
  /** Changes the cast or a setting from `slotId` on, on that branch (DESIGN §3.4). */
  Rpc.make("ChangeCast", {
    payload: { chatId: ChatId, slotId: Schema.NullOr(SlotId), change: CastChange },
    success: Cast,
    error: Schema.Union([...Errors])
  }),
  /**
   * The chat's own notes, then its characters' (participants the user doesn't play), each
   * with whether it's on after `slotId` (null: at the start).
   */
  Rpc.make("ListChatNotes", {
    payload: { chatId: ChatId, slotId: Schema.NullOr(SlotId) },
    success: Schema.Array(ChatNote),
    error: Schema.Union([...Errors])
  }),
  /** A note of the chat's own, off until the chat turns it on (`ChangeCast` with `Note`). */
  Rpc.make("CreateChatNote", {
    payload: { chatId: ChatId, title: Schema.String },
    success: LibraryRef,
    error: Schema.Union([...Errors])
  }),
  /** The chat's send queue, in order. */
  Rpc.make("ListQueued", {
    payload: { chatId: ChatId },
    success: Schema.Array(QueuedMessage),
    error: Schema.Union([...Errors])
  }),
  /** Changes a queued message's text or speaker, until it posts. */
  Rpc.make("EditQueued", {
    payload: {
      queuedId: Schema.String,
      content: Schema.String,
      speakerEntityId: Schema.NullOr(EntityId),
      expectedRowVersion: Schema.Int
    },
    success: QueuedMessage,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /**
   * Takes a queued entry back before it posts, as the user last saw it (StaleWrite if
   * another tab changed it since); returns it, so its text can go back to the composer.
   */
  Rpc.make("WithdrawQueued", {
    payload: { queuedId: Schema.String, expectedRowVersion: Schema.Int },
    success: QueuedMessage,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  })
) {}
