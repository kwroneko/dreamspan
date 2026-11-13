// What starting a chat takes (DESIGN §2.1): `StartChat` (chatSetupApi.ts) makes the chat from
// it, and `PreviewChat` (inspectorApi.ts) builds the chat's first request from it without
// writing anything. Its own module, so the inspector's API doesn't import the chat setup API.
import { Schema } from "effect"
import { EntityId, FrozenMacros, MessageImages } from "./chat.ts"

/** The first turn of a new chat: what turns a card's greeting into a chat. */
export const FirstTurn = Schema.Union([
  Schema.TaggedStruct("Send", {
    images: Schema.optionalKey(MessageImages),
    content: Schema.String,
    speakerEntityId: Schema.NullOr(EntityId)
  }),
  Schema.TaggedStruct("Generate", { speakerEntityId: Schema.NullOr(EntityId), direction: Schema.String })
])
export type FirstTurn = typeof FirstTurn.Type

/** What `StartChat` takes. */
export const StartChatInput = {
  guidance: Schema.optionalKey(Schema.Boolean),
  cards: Schema.Array(EntityId).check(Schema.isMinLength(1)),
  persona: Schema.NullOr(EntityId),
  greeting: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  first: FirstTurn,
  /**
   * What the picked greeting's random and time macros showed, kept so the chat shows it as
   * it was seen (DESIGN §5.6). The server freezes every greeting either way: it checks
   * these and draws whatever is missing.
   */
  frozen: Schema.optionalKey(FrozenMacros),
  /**
   * Who greets, in order, each greeting as its own message with all its card's greetings
   * as versions (the one picked selected) and its preview's frozen values, as ST starts a
   * group chat with each member's greeting in turn. Each must be one of `cards`; a card
   * without greetings is skipped. Absent: every card greets in cards order, randomly
   * for a group as in ST (an explicit `greeting` still chooses the first card's);
   * a single card uses `greeting` and `frozen`.
   */
  greeters: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        entityId: EntityId,
        greeting: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        frozen: Schema.optionalKey(FrozenMacros)
      })
    ).check(Schema.isMaxLength(100))
  ),
  /**
   * The chat's title; absent or blank, its cast's names. A new chat of a group takes the
   * group's name, so it's one of the group's chats (`ChatGroup`).
   */
  title: Schema.optionalKey(Schema.String)
}
