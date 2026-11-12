// The workshop beside a story (spec/WORKSHOP.md §4, W9): which one the story's Workshop tab shows.
// The URL names it (`workshop=<id>`), so a reload or a second browser tab shows the same one;
// without one, or naming one that isn't beside this story any more, the newest is shown.
import type { Chat } from "@rp/shared/chat.ts"

export const SIDE_CHAT_TAB = "workshop"
/** The URL key naming the workshop shown. */
export const SIDE_CHAT_PARAM = "workshop"
/** The scope of the shown workshop's own URL choices (its branch, its dialogs: chatPlace.ts). */
export const SIDE_CHAT_SCOPE = "side"
/** The reactivity key of a story's list of workshops. */
export const SIDE_CHATS_KEY = "side-chats"
/** What the workshop beside a story is called in the ⋯ menu. */
export const TALK_ABOUT = "Talk about this chat"

export interface SideChatChoice {
  /** The workshop shown, or none when the story has none. */
  readonly shown: Chat | null
  /** The URL named one that isn't beside the story (deleted, another story's, or mistyped). */
  readonly missing: boolean
}

/** `attached` is newest first, as `ListAttachedWorkshops` returns it. */
export const chooseSideChat = (attached: ReadonlyArray<Chat>, wanted: string | null): SideChatChoice => {
  const named = wanted === null ? undefined : attached.find((chat) => chat.id === wanted)
  if (named) return { shown: named, missing: false }
  return { shown: attached[0] ?? null, missing: wanted !== null }
}
