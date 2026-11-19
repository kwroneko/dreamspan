// What a panel's scripts may read (spec/HTML-MESSAGES.md §3.4, "The bridge", Tier B: the
// `frames.tavernHelper` part): its own message and the ones before it on the path shown, the
// chat's variables there, and the names. Read-only, and causal: nothing after the panel's
// message (memory: causal order). The client answers a panel's Tavern Helper calls from it
// (packages/client/src/frame/bootstrap.ts).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatId, ForkId, SlotId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

/** At most this many messages, the panel's own and those just before it. */
export const PANEL_MESSAGES = 100
/** At most this many characters of message text in all; older messages beyond it are left out. */
export const PANEL_TEXT = 1_000_000

/** A message as Tavern Helper's `getChatMessages` gives it. */
export const PanelMessage = Schema.Struct({
  /** Its place on the path, from 0: Tavern Helper's message id. */
  messageId: Schema.Int,
  name: Schema.String,
  role: Schema.Literals(["user", "assistant", "system"]),
  /** Left out of the context ("hidden" in ST). */
  hidden: Schema.Boolean,
  /** The shown version's text as stored. */
  message: Schema.String
})
export type PanelMessage = typeof PanelMessage.Type

export const PanelData = Schema.Struct({
  /** The panel's own message. */
  messageId: Schema.Int,
  /** In path order, ending with the panel's own message. */
  messages: Schema.Array(PanelMessage),
  /** The chat's variables after the panel's message (`{{setvar}}`'s). */
  chatVariables: Schema.Record(Schema.String, Schema.Unknown),
  /** `{{user}}` and `{{char}}` there: ST's `name1` and `name2`. */
  names: Schema.Struct({ user: Schema.String, char: Schema.String })
})
export type PanelData = typeof PanelData.Type

export class PanelDataApi extends RpcGroup.make(
  /**
   * What a panel in this message may read. Another user's chat or slot, or a slot that isn't on
   * the fork's path, is NotFound.
   */
  Rpc.make("GetPanelData", {
    payload: { chatId: ChatId, forkId: Schema.NullOr(ForkId), slotId: SlotId },
    success: PanelData,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
