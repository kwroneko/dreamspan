import type { ShellCards, ShellCardsUpdate, ShellForks, ShellForksUpdate } from "./chatSetupApi.ts"

const changed = <A>(previous: ReadonlyArray<A>, next: ReadonlyArray<A>, key: (row: A) => string) => {
  const before = new Map(previous.map((row) => [key(row), JSON.stringify(row)]))
  return next.filter((row) => before.get(key(row)) !== JSON.stringify(row))
}

export const shellCardsUpdate = (previous: ShellCards | undefined, next: ShellCards): ShellCardsUpdate => ({
  cards: changed(previous?.cards ?? [], next.cards, (row) => row.card.entityId),
  personas: changed(previous?.personas ?? [], next.personas, (row) => row.card.entityId),
  archived: changed(previous?.archived ?? [], next.archived, (row) => row.card.entityId),
  order: {
    cards: next.cards.map((row) => row.card.entityId),
    personas: next.personas.map((row) => row.card.entityId),
    archived: next.archived.map((row) => row.card.entityId)
  },
  pinsCollapsed: next.pinsCollapsed
})

export const applyShellCards = (previous: ShellCards | undefined, update: ShellCardsUpdate): ShellCards => {
  const rows = new Map(
    [
      ...(previous?.cards ?? []),
      ...(previous?.personas ?? []),
      ...(previous?.archived ?? []),
      ...update.cards,
      ...update.personas,
      ...update.archived
    ].map((row) => [row.card.entityId, row])
  )
  return {
    cards: update.order.cards.map((id) => rows.get(id)!),
    personas: update.order.personas.map((id) => rows.get(id)!),
    archived: update.order.archived.map((id) => rows.get(id)!),
    pinsCollapsed: update.pinsCollapsed
  }
}

export const shellForksUpdate = (previous: ShellForks | undefined, next: ShellForks): ShellForksUpdate => {
  const before = previous?.sections.flatMap((section) => section.rows) ?? []
  return {
    filterCounts: next.filterCounts,
    people: next.people,
    ...(next.loading ? { loading: next.loading } : {}),
    sections: next.sections.map((section) => ({
      ...section,
      rows: changed(before, section.rows, (row) => row.forkId),
      order: section.rows.map((row) => row.forkId)
    }))
  }
}

export const applyShellForks = (previous: ShellForks | undefined, update: ShellForksUpdate): ShellForks => {
  const rows = new Map(
    [
      ...(previous?.sections.flatMap((section) => section.rows) ?? []),
      ...update.sections.flatMap((section) => section.rows)
    ].map((row) => [row.forkId, row])
  )
  return {
    filterCounts: update.filterCounts,
    people: update.people,
    ...(update.loading ? { loading: update.loading } : {}),
    sections: update.sections.map((section) => ({
      id: section.id,
      total: section.total,
      rows: section.order.map((id) => rows.get(id)!)
    }))
  }
}
