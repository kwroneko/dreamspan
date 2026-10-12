// The recycle bin (DESIGN §6.2, ARCHITECTURE §3.11), merged into AppApi: what the user
// deleted, to restore in place or delete for good, and the text recovered from drafts.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem, RecoveredText } from "./bin.ts"
import { NotFound, ServerError } from "./errors.ts"

const Errors = [NotFound, ServerError] as const
const Page = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))

export class BinApi extends RpcGroup.make(
  /** Deleted items, newest first. `before` is the last item of the previous page. */
  Rpc.make("ListBin", {
    payload: { limit: Page, before: Schema.NullOr(Schema.Struct({ deletedAt: Schema.Number, id: Schema.String })) },
    success: Schema.Array(BinItem),
    error: ServerError
  }),
  /**
   * Puts an item back exactly where it was, with its versions and the chat state attached
   * to it. A chat whose leaf a deleted message took up moves back down onto it.
   */
  Rpc.make("RestoreBinItem", {
    payload: { itemId: Schema.String },
    success: BinItem,
    error: Schema.Union([...Errors])
  }),
  /** Deletes an item for good. The client asks first; this can't be undone. */
  Rpc.make("PurgeBinItem", {
    payload: { itemId: Schema.String },
    success: Schema.Void,
    error: Schema.Union([...Errors])
  }),
  Rpc.make("EmptyBin", { success: Schema.Struct({ purged: Schema.Int }), error: ServerError }),
  /** Recovered text, newest first, as excerpts. */
  Rpc.make("ListRecoveredTexts", {
    payload: { limit: Page, before: Schema.NullOr(Schema.Struct({ createdAt: Schema.Number, id: Schema.String })) },
    success: Schema.Array(RecoveredText),
    error: ServerError
  }),
  /** One recovered text in full. */
  Rpc.make("GetRecoveredText", {
    payload: { id: Schema.String },
    success: RecoveredText,
    error: Schema.Union([...Errors])
  }),
  Rpc.make("DeleteRecoveredText", {
    payload: { id: Schema.String },
    success: Schema.Void,
    error: Schema.Union([...Errors])
  })
) {}
