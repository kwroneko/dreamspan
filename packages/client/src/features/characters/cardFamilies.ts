// "Group forks" (DESIGN §4; ARCHITECTURE §12 "Card families in the character grids"): a card
// and the cards forked from it, one tile that expands to its members. Derived from the fork
// lineage the shell read reports (`ShellCard.family`); nothing is stored for it. The grouping
// runs over the cards a list already shows, in its order, so the filter, the search and the
// sort keep deciding which cards there are and where a family stands.
import type { ShellCard } from "@dreamspan/shared/chatSetupApi.ts"

export interface FamilyPlace {
  /** The family's first card's id (`ShellCard.family`). */
  readonly id: string
  /** Its members in this list. */
  readonly count: number
  readonly expanded: boolean
  /** The tile that stands for the family: the member used last. The others show only when expanded. */
  readonly head: boolean
}
export interface FamilyTile {
  readonly card: ShellCard
  /** Absent: a card on its own, or the only one of its family in this list. */
  readonly family?: FamilyPlace
}

/**
 * `cards` in their list's order, as tiles: each family of two or more once, where its first
 * member stands, by the member used last (its Recent; none used: the first in the list's
 * order), followed by its other members, in the list's order, when it's the one expanded.
 */
export const groupFamilies = (cards: ReadonlyArray<ShellCard>, expanded: string | null): Array<FamilyTile> => {
  const members = new Map<string, Array<ShellCard>>()
  for (const card of cards) {
    if (card.family === undefined) continue
    const list = members.get(card.family)
    if (list) list.push(card)
    else members.set(card.family, [card])
  }
  const tiles: Array<FamilyTile> = []
  const placed = new Set<string>()
  for (const card of cards) {
    const id = card.family
    const all = id === undefined ? undefined : members.get(id)
    if (id === undefined || all === undefined || all.length < 2) {
      tiles.push({ card })
      continue
    }
    if (placed.has(id)) continue
    placed.add(id)
    const head = all.reduce((best, member) => ((member.recentAt ?? -1) > (best.recentAt ?? -1) ? member : best))
    const open = expanded === id
    tiles.push({ card: head, family: { id, count: all.length, expanded: open, head: true } })
    if (open)
      for (const member of all)
        if (member !== head)
          tiles.push({ card: member, family: { id, count: all.length, expanded: true, head: false } })
  }
  return tiles
}
