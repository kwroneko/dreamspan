// The new-chat page's chat (DESIGN §2.1, owner 2026-11-23): its own small group, kept outside
// the core handler group's type-size bound.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Chat, ChatId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

/** What a pending chat was opened for (`OpenDraftChat`): a card's new chat, a group's, or an empty one. */
export const DraftFor = Schema.Union([
  Schema.TemplateLiteral(["card:", Schema.String]),
  Schema.TemplateLiteral(["group:", Schema.String]),
  Schema.TemplateLiteral(["workshop:", Schema.String]),
  Schema.TemplateLiteral(["side:", Schema.String]),
  Schema.Literal("empty")
])
export type DraftFor = typeof DraftFor.Type

export class DraftChatApi extends RpcGroup.make(
  /**
   * The new-chat page's chat (DESIGN §2.1, owner 2026-11-23): a real chat, pending until its
   * first turn, that nothing lists and that changes nothing (no last used time, no count) until
   * then, so the page is the saved chat's from the start. `draftFor` is the entry it is for:
   * `card:<entity>` (the card's greeting, the persona locked to it or the default),
   * `group:<chat>` (each member's random greeting, the group's name), `empty` (nobody yet),
   * `workshop:<card>:<persona>` (a workshop, its assistant and persona as `CreateWorkshop` takes
   * them: either empty for the workshop default, the persona `none` for none), `side:<story>:<fork>`
   * (a workshop beside that story, going with that branch, empty for its current one).
   * Each call makes a fresh one with fresh greetings, and sweeps the user's pending chats that
   * no tab has had open for a minute (their typing to recovered texts). `reopen`: the one the
   * page's URL names, returned as it is when it is still the user's (committed or pending for
   * the same entry), instead of a fresh one. For a swept workshop, it follows any replacement
   * or opens one with the swept workshop's attachments.
   */
  Rpc.make("OpenDraftChat", {
    payload: { draftFor: DraftFor, reopen: Schema.optionalKey(ChatId) },
    success: Chat,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * The page left a pending chat (navigated away, its tab closed): it is swept once no tab has it
   * open, its typing filed to recovered texts. Nothing for a committed chat.
   */
  Rpc.make("LeaveDraftChat", {
    payload: { chatId: ChatId },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
