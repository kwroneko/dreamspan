// What the message list needs for the account's message spacing (ChatDensity.tsx): its numbers
// for the virtualizer, and the reader's place, noted before the spacing changes and found again
// after, so the text being read stays where it is on screen.
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual"
import type { DisplayPrefs } from "@rp/shared/chatApi.ts"

export type ChatDensity = DisplayPrefs["chatDensity"]

/** What the message list's virtualizer needs to know about a density. */
export const densityMetrics = (density: ChatDensity) =>
  density === "compact"
    ? // A compact row is about four fifths of a comfortable one (measured in e2e/readingDensity.spec.ts).
      { gap: 4, estimate: 0.8 }
    : { gap: 6, estimate: 1 }

/** Where reading is: a row of the list, a block of its text, and how far below the list's top each starts. */
export interface ReadingAnchor {
  /** The row's index in the list (`data-index`). */
  readonly row: number
  readonly rowOffset: number
  /** Which block of the row's text, counted through the row; -1 when the row has none in view. */
  readonly block: number
  readonly offset: number
}

const blocksOf = (row: Element) => [...row.querySelectorAll(".markdown > *")]

/**
 * What stays where it is on screen when the spacing changes: the first block of text (failing
 * that, the first row) that reaches below the list's top edge.
 */
export const readingAnchor = (list: HTMLElement): ReadingAnchor | null => {
  const viewport = list.getBoundingClientRect()
  const top = viewport.top
  const below = (element: Element) => element.getBoundingClientRect().bottom > top + 1
  const rows = [...list.querySelectorAll<HTMLElement>(".chat-row[data-index]")].filter(below)
  // A preceding row can reach the edge only through its marker/footer tail. Prefer
  // the first text still being read, across rows, before falling back to a row box.
  const row =
    rows.find((candidate) =>
      blocksOf(candidate).some((block) => below(block) && block.getBoundingClientRect().top < viewport.bottom)
    ) ?? rows[0]
  if (row === undefined) return null
  const rowOffset = row.getBoundingClientRect().top - top
  const block = blocksOf(row).findIndex(below)
  return {
    row: Number(row.dataset.index),
    rowOffset,
    block,
    offset: block < 0 ? rowOffset : blocksOf(row)[block]!.getBoundingClientRect().top - top
  }
}

/** How far the anchor now is from where it was, in pixels down the screen; null while its row isn't shown. */
export const readingDrift = (list: HTMLElement, anchor: ReadingAnchor, row: number): number | null => {
  const element = list.querySelector(`.chat-row[data-index="${row}"]`)
  if (element === null) return null
  const top = list.getBoundingClientRect().top
  const block = anchor.block < 0 ? undefined : blocksOf(element)[anchor.block]
  return block === undefined
    ? element.getBoundingClientRect().top - top - anchor.rowOffset
    : block.getBoundingClientRect().top - top - anchor.offset
}

/**
 * How far below its row's top the list's top edge must be for the anchor to be where it was:
 * by the anchor's block inside the row as it's laid out now, or by the row's own top when the
 * block isn't there (the row isn't shown, or its text isn't rendered yet).
 */
export const readingInset = (list: HTMLElement, anchor: ReadingAnchor, row: number): number => {
  const element = list.querySelector(`.chat-row[data-index="${row}"]`)
  const block = element === null || anchor.block < 0 ? undefined : blocksOf(element)[anchor.block]
  return block === undefined || element === null
    ? -anchor.rowOffset
    : block.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
}

/** Whether a row resize moves what is being read (the native virtualizer owns the correction). */
export const adjustForReading = (
  item: VirtualItem,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  readingRow: number | null
): boolean => {
  // Match TanStack's native first-measure rule: a newly prepended estimate above the fold
  // must be corrected even while the DOM still carries the previous window's row indices.
  // Already measured rows keep the text anchor used for late marker/footer growth.
  if (!virtualizer.itemSizeCache.has(item.key))
    return item.start < (virtualizer.scrollOffset ?? 0) + virtualizer.scrollAdjustments
  return readingRow !== null && item.index < readingRow
}
