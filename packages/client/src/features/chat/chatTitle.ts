// How a chat is named in lists and headers (DESIGN §2.1: never a file name, never just the
// first character's name): the card or group name, with the day ST started it beside it
// (`@rp/shared/chatName.ts`, which the server groups chats by too).

import { chatName } from "@rp/shared/chatName.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import type { ChatView } from "./session.ts"

export { chatName }

const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const shortFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })

export const formatDay = (date: Date) => dayFormat.format(date)

/** "14:05" today, "Mar 4" this year, "Mar 4, 2025" before. */
export const formatWhen = (at: number, now = Date.now()) => {
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return timeFormat.format(date)
  if (date.getFullYear() === today.getFullYear()) return shortFormat.format(date)
  return dayFormat.format(date)
}

/** A chat's title as people read it: "The Lantern Inn, started Apr 3, 2026", never ST's file name. */
export const readableChatTitle = (title: string) => {
  const name = chatName(importState(title).title, [])
  return name.started ? `${name.name}, started ${formatDay(name.started)}` : name.name
}

/** The characters in the chat shown, the user's own left out: the header's faces and names. */
export const castCharacters = (view: Pick<ChatView, "cast">) => {
  const cast = view.cast
  return (cast?.participants ?? [])
    .filter((id) => !cast!.playedByMe.includes(id))
    .flatMap((id) => cast!.cards.filter((card) => card.entityId === id))
}

/** The chat's readable name, as the header shows it (never ST's file name). */
export const chatDisplayName = (view: Pick<ChatView, "cast" | "chat">) =>
  view.chat ? chatName(importState(view.chat.title).title, castCharacters(view)).name : "Chat"
