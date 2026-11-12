// Finding text across many things at once (ARCHITECTURE §12 "Finding a message"): message text
// in all of the user's chats. The RPCs are their own group, merged into AppApi like the merge group.
import { Rpc, RpcGroup } from "effect/rpc"
import { Schema } from "effect"
import { ServerError } from "./errors.ts"
import { MessageCursor, MessageQuery, MessageSearchPage } from "./messageSearch.ts"

export class TextSearchApi extends RpcGroup.make(
  /**
   * Messages in all of the user's chats whose text has each of `text`'s words (as the start of
   * a word), newest first: each a message version with the branches that show it
   * (messageSearch.ts). `cursor` is the previous page's `next`.
   */
  Rpc.make("SearchMessages", {
    payload: { text: MessageQuery, cursor: Schema.NullOr(MessageCursor) },
    success: MessageSearchPage,
    error: ServerError
  })
) {}
