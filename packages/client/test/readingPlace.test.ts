// @vitest-environment jsdom
// The reader's place across a change of message spacing (job reading1): the first text reaching
// below the list's top edge is the anchor, and its drift is measured against where it was.
import { Virtualizer } from "@tanstack/react-virtual"
import { expect, it } from "vitest"
import {
  adjustForReading,
  densityMetrics,
  readingAnchor,
  readingDrift,
  readingInset
} from "../src/features/chat/readingPlace.ts"

const place = (element: Element, top: number, height: number) => {
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect
}

/** A list at y=100 whose rows hold blocks of text at the given tops and heights. */
const listOf = (rows: ReadonlyArray<{ top: number; height: number; blocks: ReadonlyArray<[number, number]> }>) => {
  const list = document.createElement("div")
  place(list, 100, 600)
  rows.forEach((row, index) => {
    const element = document.createElement("div")
    element.className = "chat-row"
    element.dataset.index = String(index)
    place(element, row.top, row.height)
    const text = document.createElement("div")
    text.className = "markdown"
    for (const [top, height] of row.blocks) {
      const block = document.createElement("p")
      place(block, top, height)
      text.append(block)
    }
    element.append(text)
    list.append(element)
  })
  return list
}

it("compact rows are estimated shorter and closer together; comfortable is unchanged", () => {
  expect(densityMetrics("comfortable")).toEqual({ gap: 6, estimate: 1 })
  const compact = densityMetrics("compact")
  expect(compact.gap).toBeLessThan(6)
  expect(compact.estimate).toBeGreaterThan(0.5)
  expect(compact.estimate).toBeLessThan(1)
})

it("anchors on the first block of text that reaches below the list's top edge", () => {
  const list = listOf([
    { top: -200, height: 150, blocks: [[-190, 130]] },
    {
      top: -40,
      height: 400,
      blocks: [
        [-30, 100],
        [80, 60],
        [150, 200]
      ]
    },
    { top: 366, height: 100, blocks: [[376, 80]] }
  ])
  // Row 1 spans the edge; its first block ends above it, its second (80..140) crosses y=100.
  expect(readingAnchor(list)).toEqual({ row: 1, rowOffset: -140, block: 1, offset: -20 })
})

it("keeps visible text when only a preceding row's marker remains at the top", () => {
  const list = listOf([
    { top: -200, height: 340, blocks: [[-190, 250]] },
    { top: 146, height: 300, blocks: [[156, 180]] }
  ])
  // Row 0's text ends at 60; only its contribution/footer tail crosses the top at 100.
  expect(readingAnchor(list)).toEqual({ row: 1, rowOffset: 46, block: 0, offset: 56 })
})

it("keeps an image-only row when the next text is outside the viewport", () => {
  const list = listOf([
    { top: 90, height: 620, blocks: [] },
    { top: 716, height: 100, blocks: [[726, 80]] }
  ])
  expect(readingAnchor(list)).toEqual({ row: 0, rowOffset: -10, block: -1, offset: -10 })
})

it("anchors on the row itself when none of its text is in view", () => {
  const list = listOf([{ top: 90, height: 40, blocks: [] }])
  expect(readingAnchor(list)).toEqual({ row: 0, rowOffset: -10, block: -1, offset: -10 })
  expect(readingAnchor(listOf([]))).toBeNull()
})

it("measures how far the anchor moved, by its block, or by its row until the text is there", () => {
  const before = listOf([
    {
      top: 60,
      height: 300,
      blocks: [
        [70, 20],
        [95, 100]
      ]
    }
  ])
  const anchor = readingAnchor(before)!
  expect(anchor).toMatchObject({ row: 0, block: 1, offset: -5 })
  const after = listOf([
    {
      top: 40,
      height: 240,
      blocks: [
        [46, 18],
        [70, 90]
      ]
    }
  ])
  // The block was 5 px above the edge and is now 30 px above it: it drifted 25 px up.
  expect(readingDrift(after, anchor, 0)).toBe(-25)
  // Its text not rendered yet: by the row's own top (was -40, now -60).
  expect(readingDrift(listOf([{ top: 40, height: 240, blocks: [] }]), anchor, 0)).toBe(-20)
  // Its row isn't among those shown.
  expect(readingDrift(after, anchor, 7)).toBeNull()
  // Scrolled to the row's start plus this, the block is 5 px above the edge again: it now
  // starts 30 px into its row.
  expect(readingInset(after, anchor, 0)).toBe(35)
  expect(readingInset(after, anchor, 7)).toBe(40)
})

it("native first measurements keep an estimated prefix anchored before the DOM row indices commit", () => {
  const writes: number[] = []
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: 20,
    getScrollElement: () => null,
    estimateSize: () => 100,
    initialOffset: 150,
    initialRect: { width: 400, height: 100 },
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
    scrollToFn: (offset, { adjustments }) => {
      writes.push(offset + (adjustments ?? 0))
    }
  })
  virtualizer.getVirtualItems()
  // A prepend has updated the virtual positions, while the old first row still says index 0.
  let readingRow = 0
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => adjustForReading(item, virtualizer, readingRow)
  virtualizer.resizeItem(0, 200)
  expect(virtualizer.scrollOffset).toBe(250)
  expect(writes).toEqual([250])
  // A new row below the fold doesn't move reading; a later marker above it still does.
  virtualizer.resizeItem(3, 300)
  expect(writes).toEqual([250])
  readingRow = 1
  virtualizer.resizeItem(0, 250)
  expect(virtualizer.scrollOffset).toBe(300)
  expect(writes).toEqual([250, 300])
})
