// The Lorebooks tab's one list (owner, 2026-11-01: rows mustn't appear, vanish or show twice):
// each member card's own book, the books added to this chat in the order they were added, then
// the preset's books not already listed. A book added to the chat stays listed, off, when it's
// switched off (`Cast.listedLorebooks`), until it's removed. A switch shows its new state at
// once (`pending`), confirmed in the background; the tab drops it once the server agrees.

export type BookSource = "card" | "chat" | "preset"

export interface BookRow {
  /** Stable: `card:<entity>`, `chat:<ref>`, `preset:<ref>`. */
  readonly key: string
  readonly source: BookSource
  /** The card holding it (its own book), or the lorebook's ref. */
  readonly id: string
  readonly on: boolean
  /** Switched here, not confirmed yet. */
  readonly pending: boolean
  /** A chat's book the preset sends as well, on there: off here, it's still sent. */
  readonly presetSends: boolean
}

export interface RowInput {
  /** Member cards with a book of their own, in the cast's order. */
  readonly cards: ReadonlyArray<string>
  readonly cardsOff: ReadonlyArray<string>
  readonly listed: ReadonlyArray<{ readonly ref: string; readonly on: boolean }>
  /** The preset's books, in its order; empty while it loads or without one. */
  readonly preset: ReadonlyArray<{ readonly id: string; readonly enabled: boolean }>
  /** Switches made here and not confirmed, by row key. */
  readonly pending: ReadonlyMap<string, boolean>
}

export const lorebookRows = (input: RowInput): ReadonlyArray<BookRow> => {
  const row = (source: BookSource, id: string, on: boolean, presetSends = false): BookRow => {
    const key = `${source}:${id}`
    const wanted = input.pending.get(key)
    return { key, source, id, on: wanted ?? on, pending: wanted !== undefined && wanted !== on, presetSends }
  }
  const listed = new Set(input.listed.map((book) => book.ref))
  const sentByPreset = new Set(input.preset.filter((book) => book.enabled).map((book) => book.id))
  return [
    ...input.cards.map((entity) => row("card", entity, !input.cardsOff.includes(entity))),
    ...input.listed.map((book) => row("chat", book.ref, book.on, sentByPreset.has(book.ref))),
    ...input.preset.filter((book) => !listed.has(book.id)).map((book) => row("preset", book.id, book.enabled))
  ]
}
