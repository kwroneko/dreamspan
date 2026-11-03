/** The Chats tab's browse choices, applied in the reader before paging. */
import { Schema } from "effect"

export const CHAT_FILTERS = ["all", "pinned", "groups", "solo", "branches"] as const
export const CHAT_SORTS = ["recent", "started", "name", "messages", "branches"] as const
export const ChatBrowse = Schema.Struct({
  filter: Schema.Literals(CHAT_FILTERS),
  sort: Schema.Literals(CHAT_SORTS),
  reversed: Schema.Boolean
})
export type ChatBrowse = typeof ChatBrowse.Type
export const ChatFilterCounts = Schema.Struct({
  all: Schema.Int,
  pinned: Schema.Int,
  groups: Schema.Int,
  solo: Schema.Int,
  branches: Schema.Int
})
export type ChatFilterCounts = typeof ChatFilterCounts.Type
