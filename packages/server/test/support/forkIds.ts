// The fork a test built a line for: the one whose tip is the line's last message.
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { client } from "./config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/**
 * Deletes the chat's current fork as the whole subtree below `parentSlotId` (null: the whole chat),
 * which the code before forks did with one call: another fork is made there first, since a chat's
 * last fork isn't deleted, and the current one is deleted. The messages below `parentSlotId` that
 * no other fork shows are the deleted ones.
 */
export const deleteBranchBelow = (api: Api, chatId: ChatId, parentSlotId: SlotId | null) =>
  Effect.gen(function* () {
    const chat = yield* api.GetChat({ chatId })
    yield* api.CreateFork({ chatId, fromForkId: chat.currentForkId, atSlotId: parentSlotId })
    return yield* api.DeleteFork({ forkId: chat.currentForkId! })
  })
