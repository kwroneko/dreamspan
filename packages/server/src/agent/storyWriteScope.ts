// Story writes use the same validated position as story reads. A side workshop never
// falls back to a story's last write, including when opened in its own browser tab.
import { Effect } from "effect"
import type { Chat, StoryAt } from "@rp/shared/chat.ts"
import { attachedStory } from "./storyReadScope.ts"
import { storyContext } from "./tools/history.ts"
import { ToolInputRefused, type ToolContext } from "./tools.ts"

export type WriteChat = Chat & {
  readonly storyTarget?: StoryAt
  readonly upTo?: number
  readonly branchLabel?: string
}
export const storyWriteChat = Effect.fnUntraced(function* (ctx: ToolContext, chat: Chat) {
  const attached = yield* attachedStory(ctx)
  if (attached === undefined) return chat as WriteChat
  if (attached !== chat.id)
    return yield* Effect.fail(new ToolInputRefused("This side chat can read or change only the story it is beside."))
  const place = yield* storyContext(ctx)
  if ("error" in place) return yield* Effect.fail(new ToolInputRefused(place.error))
  return {
    ...chat,
    currentForkId: place.context.forkId,
    activeLeafSlotId: place.context.leafSlotId,
    storyTarget: ctx.storyAt!,
    upTo: place.place.upTo,
    branchLabel: place.place.branch ?? "Unnamed branch"
  } satisfies WriteChat
})
