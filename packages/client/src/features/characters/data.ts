// The characters' data (DESIGN §2.1): every character card with its use, in one read shared
// by the grid and the card page, and where a click on one goes.
import type { CardUsage } from "@rp/shared/chatSetupApi.ts"
import { AppClient } from "../../rpc.ts"

/** Read again when a chat is made or deleted, or a card changes. */
export const usageAtom = AppClient.query("ListCardUsage", undefined, { reactivityKeys: ["chats", "library"] })

/** One click from the grid: the latest chat, or the card's greeting when it has none (nothing is made). */
export const openTarget = (card: CardUsage) =>
  card.latestChatId === null
    ? ({ to: "/cards/$entityId/chat", params: { entityId: card.entityId } } as const)
    : ({ to: "/chats/$chatId", params: { chatId: card.latestChatId } } as const)

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "5 minutes ago", "yesterday", "3 weeks ago", "last year". */
const formatAgo = (at: number, now = Date.now()) => {
  const elapsed = now - at
  if (elapsed < 60_000) return "just now"
  // Days count calendar days, so last night is "yesterday" this morning.
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days === 0) {
    const hours = Math.floor(elapsed / 3_600_000)
    return hours === 0 ? relative.format(-Math.floor(elapsed / 60_000), "minute") : relative.format(-hours, "hour")
  }
  if (days < 7) return relative.format(-days, "day")
  if (days < 30) return relative.format(-Math.floor(days / 7), "week")
  if (days < 365) return relative.format(-Math.floor(days / 30), "month")
  return relative.format(-Math.floor(days / 365), "year")
}

const chatCount = (card: CardUsage) => `${card.chats.toLocaleString()} chat${card.chats === 1 ? "" : "s"}`

/** "12 chats · last chatted 3 days ago", or "Never used". */
export const usageLine = (card: CardUsage, now = Date.now()) => {
  if (card.chats === 0) return "Never used"
  return card.lastMessageAt === null
    ? chatCount(card)
    : `${chatCount(card)} · last chatted ${formatAgo(card.lastMessageAt, now)}`
}

/** The same for a tile, which has room for less: "12 chats · 3 days ago". */
export const shortUsageLine = (card: CardUsage, now = Date.now()) => {
  if (card.chats === 0) return "Never used"
  return card.lastMessageAt === null ? chatCount(card) : `${chatCount(card)} · ${formatAgo(card.lastMessageAt, now)}`
}

export type Sort = "recent" | "name"

const byName = (a: CardUsage, b: CardUsage) =>
  a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }) ||
  a.subtitle.localeCompare(b.subtitle, undefined, { numeric: true, sensitivity: "base" })

/** Recents by last message, never by last opened (DESIGN §2.1); cards never used after them, by name. */
export const sortCards = (cards: ReadonlyArray<CardUsage>, sort: Sort) =>
  [...cards].sort((a, b) =>
    sort === "name" ? byName(a, b) : (b.lastMessageAt ?? -1) - (a.lastMessageAt ?? -1) || byName(a, b)
  )

/** Cards whose label, subtitle or in-chat name has the text in it, ignoring case and accents. */
export const matches = (card: CardUsage, needle: string) => {
  if (needle === "") return true
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
  const want = fold(needle)
  return [card.label, card.subtitle, card.name].some((text) => fold(text).includes(want))
}
