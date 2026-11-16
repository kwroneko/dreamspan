// Acting on several messages at once (job msgactions1; ST-COMPARISON item 24): delete the messages
// ticked in a fork as one change, and its Undo; hide them from the model or show them (selecthide1). A group of its own, merged into AppApi like the
// split chats, so the core group stays within TypeScript's instantiation limit.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem, DeletedSlots, RestoredItems } from "./bin.ts"
import { ForkId, SlotId } from "./chat.ts"
import { NotFound, ServerError } from "./errors.ts"

export class MessageSelectionApi extends RpcGroup.make(
  /**
   * Deletes several messages in fork `forkId` as one change, each as DeleteMessage would, with
   * a bin item each (in the path's order, top down); RestoreBinItems with their ids is the Undo.
   * Other forks that show them keep them. Nothing is deleted if any isn't live in that fork.
   */
  Rpc.make("DeleteMessages", {
    payload: { forkId: ForkId, slotIds: DeletedSlots },
    success: Schema.Array(BinItem),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Hides several messages of fork `forkId` from the model, or shows them again, as one change:
   * each as SetMessageHidden would, in that fork only (job selecthide1). Nothing changes if any
   * isn't live. `changed`: those that weren't so already; the same call with the opposite
   * `hidden` and those ids is the Undo.
   */
  Rpc.make("SetMessagesHidden", {
    payload: { forkId: ForkId, slotIds: DeletedSlots, hidden: Schema.Boolean },
    success: Schema.Struct({ changed: Schema.Array(SlotId) }),
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Puts several bin items back in one change, in the order given: a multi-delete's Undo. Those
   * no longer in the bin are skipped; NotFound when none is.
   */
  Rpc.make("RestoreBinItems", {
    payload: { itemIds: RestoredItems },
    success: Schema.Array(BinItem),
    error: Schema.Union([NotFound, ServerError])
  })
) {}
