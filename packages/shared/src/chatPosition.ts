import { Schema } from "effect"
import { idSchema } from "./id.ts"

export const ChatId = idSchema("ChatId", "chat")
export type ChatId = typeof ChatId.Type

export const SlotId = idSchema("SlotId", "slot")
export type SlotId = typeof SlotId.Type

export const ForkId = idSchema("ForkId", "fork")
export type ForkId = typeof ForkId.Type

/**
 * Where a side chat reads its story (spec/WORKSHOP.md §4): the story, the branch and the newest
 * message shown in the browser tab the side chat was used from, sent with each request from it.
 * `leafSlotId` null: that branch has no messages. Nothing after the leaf is read.
 */
export const StoryAt = Schema.Struct({ chatId: ChatId, forkId: ForkId, leafSlotId: Schema.NullOr(SlotId) })
export type StoryAt = typeof StoryAt.Type
/** The optional request field every reply-starting RPC takes. */
export const StoryAtField = Schema.optionalKey(StoryAt)
