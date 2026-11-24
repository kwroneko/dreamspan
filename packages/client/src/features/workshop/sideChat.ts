// The workshop beside a story (spec/WORKSHOP.md §4, W9): which one the story's Workshop tab shows.
// The URL names it (`workshop=<id>`), so a reload or a second browser tab shows the same one;
// without one, or naming one that isn't beside this story any more, the newest is shown.
// `workshop=new` is one not made yet: its composer, made by its first message (owner, 2026-11-17).
import type { Chat } from "@dreamspan/shared/chat.ts"

export const SIDE_CHAT_TAB = "workshop"
/** The URL key naming the workshop shown. */
export const SIDE_CHAT_PARAM = "workshop"
/** The URL's name for a workshop not made yet: the tab shows its composer. */
export const NEW_SIDE_CHAT = "new"
/** The scope of the shown workshop's own URL choices (its branch, its dialogs: chatPlace.ts). */
export const SIDE_CHAT_SCOPE = "side"
/** The reactivity key of a story's list of workshops. */
export const SIDE_CHATS_KEY = "side-chats"
/** What the workshop beside a story is called in the ⋯ menu. */
export const TALK_ABOUT = "Talk about this chat"

/** A different workshop cannot inherit the previous one's branch or open dialogs. */
export const sideChatSearch = (previous: Record<string, unknown>, id: string) => {
  const search: Record<string, unknown> = { ...previous, [SIDE_CHAT_PARAM]: id || undefined }
  if (previous[SIDE_CHAT_PARAM] !== id)
    for (const key of Object.keys(search)) if (key.startsWith(`${SIDE_CHAT_SCOPE}.`)) delete search[key]
  return search
}

export interface SideChatChoice {
  /** The workshop shown, or none: one not made yet, made by its first message. */
  readonly shown: Chat | null
  /** The URL named one that isn't beside the story (deleted, another story's, or mistyped). */
  readonly missing: boolean
}

/** `attached` is newest first, as `ListAttachedWorkshops` returns it. */
export const chooseSideChat = (attached: ReadonlyArray<Chat>, wanted: string | null): SideChatChoice => {
  if (wanted === NEW_SIDE_CHAT) return { shown: null, missing: false }
  const named = wanted === null ? undefined : attached.find((chat) => chat.id === wanted)
  if (named) return { shown: named, missing: false }
  return { shown: attached[0] ?? null, missing: wanted !== null }
}
