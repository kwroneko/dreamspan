// The characters' data (DESIGN §2.1): every character card with its use, in one read shared
// by the grid and the card page, the groups of chats beside them (ST's group tiles), and
// where a click on one goes.
import type { CardUsage, ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { AppClient } from "../../rpc.ts"

/** Read again when a chat is made or deleted, or a card changes. */
export const usageAtom = AppClient.query("ListCardUsage", undefined, { reactivityKeys: ["chats", "library"] })

/** The groups, read on the server in one go; again when a chat or a card changes. */
export const groupsAtom = AppClient.query("ListChatGroups", undefined, { reactivityKeys: ["chats", "library"] })

/** A tile on the grid: a character, or a group of chats. */
export type Tile =
  { readonly kind: "card"; readonly card: CardUsage } | { readonly kind: "group"; readonly group: ChatGroup }

/** What the usage lines need: a card's or a group's chats and last message. */
interface Used {
  readonly chats: number
  readonly lastMessageAt: number | null
}

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

const chatCount = (card: Used) => `${card.chats.toLocaleString()} chat${card.chats === 1 ? "" : "s"}`

/** "12 chats · last chatted 3 days ago", or "Never used". */
export const usageLine = (card: Used, now = Date.now()) => {
  if (card.chats === 0) return "Never used"
  return card.lastMessageAt === null
    ? chatCount(card)
    : `${chatCount(card)} · last chatted ${formatAgo(card.lastMessageAt, now)}`
}

/** The same for a tile, which has room for less: "12 chats · 3 days ago". */
export const shortUsageLine = (card: Used, now = Date.now()) => {
  if (card.chats === 0) return "Never used"
  return card.lastMessageAt === null ? chatCount(card) : `${chatCount(card)} · ${formatAgo(card.lastMessageAt, now)}`
}

export type Sort = "recent" | "name"

const nameOf = (tile: Tile) => (tile.kind === "card" ? tile.card.label : tile.group.name)
const subtitleOf = (tile: Tile) => (tile.kind === "card" ? tile.card.subtitle : "")
const lastOf = (tile: Tile) => (tile.kind === "card" ? tile.card : tile.group).lastMessageAt

const byName = (a: Tile, b: Tile) =>
  nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: "base" }) ||
  subtitleOf(a).localeCompare(subtitleOf(b), undefined, { numeric: true, sensitivity: "base" })

/**
 * Recents by last message, never by last opened (DESIGN §2.1), groups and characters mixed as
 * ST mixes them; cards never used after them, by name.
 */
export const sortTiles = (tiles: ReadonlyArray<Tile>, sort: Sort) =>
  [...tiles].sort((a, b) =>
    sort === "name"
      ? byName(a, b)
      : (lastOf(b) ?? -1) - (lastOf(a) ?? -1) ||
        // A group before its members, whose last message is the group's.
        (a.kind === b.kind ? 0 : a.kind === "group" ? -1 : 1) ||
        byName(a, b)
  )

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()

/**
 * Tiles whose name has the text in it, ignoring case and accents: a card's label, subtitle
 * or in-chat name; a group's name or its members' names.
 */
export const matches = (tile: Tile, needle: string) => {
  if (needle === "") return true
  const want = fold(needle)
  const texts =
    tile.kind === "card"
      ? [tile.card.label, tile.card.subtitle, tile.card.name]
      : [tile.group.name, ...tile.group.members.flatMap((member) => [member.name, member.label])]
  return texts.some((text) => fold(text).includes(want))
}
