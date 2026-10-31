// "Recent" for characters: the latest activity in any of the card's chats, imported dates
// included, as ST sorts by date_last_chat. The home grid and the left panel's grid sort by
// this one key, the same date the panel's chat rows sort by (each fork's `recentAt`). The
// shell read's own `ShellCard.recentAt` is also the card's import or edit time, so after an
// import every card would tie on it.

interface ForkActivity {
  readonly joined: ReadonlyArray<string>
  readonly recentAt: number
}
interface SortableCard {
  readonly card: { readonly entityId: string; readonly label: string; readonly subtitle: string }
  readonly createdAt: number
}
type CardSort = "recent" | "created" | "name"

/** Each card's latest chat activity, over every fork it ever joined. */
export const lastChatAt = (forks: ReadonlyArray<ForkActivity>): ReadonlyMap<string, number> => {
  const latest = new Map<string, number>()
  for (const fork of forks)
    for (const id of fork.joined) if (fork.recentAt > (latest.get(id) ?? -Infinity)) latest.set(id, fork.recentAt)
  return latest
}

const byName = (a: SortableCard, b: SortableCard) =>
  a.card.label.localeCompare(b.card.label) || a.card.subtitle.localeCompare(b.card.subtitle)

/** Recent puts never-used cards last, newest first, as ST does with no last chat date. */
export const sortCards = <Card extends SortableCard>(
  cards: ReadonlyArray<Card>,
  latest: ReadonlyMap<string, number>,
  sort: CardSort
): Array<Card> =>
  [...cards].sort((a, b) => {
    if (sort === "name") return byName(a, b)
    if (sort === "created") return b.createdAt - a.createdAt || byName(a, b)
    const x = latest.get(a.card.entityId)
    const y = latest.get(b.card.entityId)
    if (x === undefined || y === undefined) {
      if (x !== y) return x === undefined ? 1 : -1
      return b.createdAt - a.createdAt || byName(a, b)
    }
    return y - x || byName(a, b)
  })
