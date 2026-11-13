// A side workshop's reading grant names its immutable attachment, never every chat.
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { ToolInputRefused, type ToolContext } from "./tools.ts"

export const checkStoryReadScope = Effect.fnUntraced(function* (ctx: ToolContext, target?: string) {
  const attached = foldState(
    yield* ctx.reader.StateEventsAt({
      userId: ctx.userId,
      chatId: ctx.chatId,
      forkId: ctx.forkId,
      slotId: ctx.leafSlotId
    })
  ).workshopAttached
  if (attached !== undefined && attached !== target)
    return yield* Effect.fail(
      new ToolInputRefused("This workshop can read only the story it is beside. Use the story tools.")
    )
})
