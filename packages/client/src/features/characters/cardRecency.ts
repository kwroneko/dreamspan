// How characters sort: the home grid, the left panel's grid and Start a chat share these.
// "Recent" is the shell read's `ShellCard.recentAt` (db/shellReads.ts): the latest activity in
// any of the card's chats, imported dates included, as ST sorts by date_last_chat; null while it
// has none. "Created" is `createdAt` (an ST import's card file date), "Added" `addedAt` (when it
// came into this app).

interface SortableCard {
  readonly card: { readonly entityId: string; readonly label: string; readonly subtitle: string }
  readonly createdAt: number
  readonly addedAt: number
  readonly recentAt: number | null
}
export type CardSort = "recent" | "created" | "added" | "name"

const byName = (a: SortableCard, b: SortableCard) =>
  a.card.label.localeCompare(b.card.label) || a.card.subtitle.localeCompare(b.card.subtitle)

/** The date a sort orders by, null for Name (and Recent with no chat). */
export const sortDate = (card: SortableCard, sort: CardSort): number | null =>
  sort === "recent" ? card.recentAt : sort === "created" ? card.createdAt : sort === "added" ? card.addedAt : null

/** A tile's date: "now", "5m ago", "3h ago", "2d ago", "3w ago", "4mo ago", then "Mar 2024". */
export const shortAgo = (at: number, now = Date.now()) => {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return new Date(at).toLocaleDateString(undefined, { month: "short", year: "numeric" })
}

/**
 * Dates newest first and names A to Z; `reversed`, the other way round. Recent puts never-used
 * cards last either way, newest made first, as ST does with no last chat date.
 */
export const sortCards = <Card extends SortableCard>(
  cards: ReadonlyArray<Card>,
  sort: CardSort,
  reversed = false
): Array<Card> => {
  const turn = reversed ? -1 : 1
  return [...cards].sort((a, b) => {
    if (sort === "name") return turn * byName(a, b)
    const x = sortDate(a, sort)
    const y = sortDate(b, sort)
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1
      return b.createdAt - a.createdAt || byName(a, b)
    }
    return turn * (y - x) || byName(a, b)
  })
}
