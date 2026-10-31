// "Recent" for characters: the home grid, the left panel's grid and Start a chat sort by one
// key, the shell read's `ShellCard.recentAt` (db/shellReads.ts): the latest activity in any of
// the card's chats, imported dates included, as ST sorts by date_last_chat; null while it has
// none.

interface SortableCard {
  readonly card: { readonly entityId: string; readonly label: string; readonly subtitle: string }
  readonly createdAt: number
  readonly recentAt: number | null
}
type CardSort = "recent" | "created" | "name"

const byName = (a: SortableCard, b: SortableCard) =>
  a.card.label.localeCompare(b.card.label) || a.card.subtitle.localeCompare(b.card.subtitle)

/** Recent puts never-used cards last, newest first, as ST does with no last chat date. */
export const sortCards = <Card extends SortableCard>(cards: ReadonlyArray<Card>, sort: CardSort): Array<Card> =>
  [...cards].sort((a, b) => {
    if (sort === "name") return byName(a, b)
    if (sort === "created") return b.createdAt - a.createdAt || byName(a, b)
    const x = a.recentAt
    const y = b.recentAt
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1
      return b.createdAt - a.createdAt || byName(a, b)
    }
    return y - x || byName(a, b)
  })
