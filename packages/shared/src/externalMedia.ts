// External message media consent (HTML-MESSAGES §3.2/§3.5). Account-owned settings,
// independent of imported documents and of permission to run panel scripts.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, EntityId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

export const ExternalMediaPrefs = Schema.Struct({
  default: Schema.Boolean,
  cards: Schema.Record(Schema.String, Schema.Boolean),
  chats: Schema.Record(Schema.String, Schema.Boolean)
})
export type ExternalMediaPrefs = typeof ExternalMediaPrefs.Type
export const DEFAULT_EXTERNAL_MEDIA: ExternalMediaPrefs = { default: false, cards: {}, chats: {} }
export const ExternalMediaTarget = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Default") }),
  Schema.Struct({ _tag: Schema.Literal("Card"), id: EntityId }),
  Schema.Struct({ _tag: Schema.Literal("Chat"), id: ChatId })
])
export type ExternalMediaTarget = typeof ExternalMediaTarget.Type

/** A chat override wins, then the message's card, then the account default. */
export const externalMediaAllowed = (prefs: ExternalMediaPrefs, chat: string | null, card: string | null) =>
  (chat === null ? undefined : prefs.chats[chat]) ?? (card === null ? undefined : prefs.cards[card]) ?? prefs.default

export class ExternalMediaApi extends RpcGroup.make(
  Rpc.make("GetExternalMediaPrefs", { payload: {}, success: ExternalMediaPrefs, error: ServerError }),
  Rpc.make("SetExternalMedia", {
    payload: { target: ExternalMediaTarget, allow: Schema.NullOr(Schema.Boolean) },
    success: ExternalMediaPrefs,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
