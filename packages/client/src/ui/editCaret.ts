// Where a double-click on a message puts the caret of the edit it opens: the browser's caret at
// the point, as an offset in the message's stored text. Registered locators answer in order
// (lowest first, the first offset wins), so a plugin can add, replace or disable one by id:
// the body's source map first, exact wherever the renderer mapped the text; the words around
// the point after it, for whatever the map doesn't cover.
import { makeRegistry } from "../registry.ts"
import { contextOffset } from "./caretContext.ts"
import { messageBodyAt, sourceOffsetAt } from "./messageCopy.tsx"

export interface CaretPoint {
  readonly node: Node
  readonly offset: number
}

export interface EditCaretLocator {
  readonly id: string
  /** Lower answers first. */
  readonly order: number
  /** The offset in `source` (the text the editor opens with) of a point in the message, or null. */
  readonly locate: (point: CaretPoint, source: string) => number | null
}

export const editCaretLocators = makeRegistry<EditCaretLocator>()

/** Where an edit opens: the caret's offset, and the viewport y its line had in the message. */
export interface EditCaret {
  readonly offset: number
  readonly top: number
}

/** The browser's caret at a point, as a text position. */
function caretFromPoint(x: number, y: number): CaretPoint | null {
  const position = document.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** The top of the line at a text position, in the viewport; `y` when it has no box. */
function lineTop({ node, offset }: CaretPoint, y: number): number {
  if (node.nodeType !== Node.TEXT_NODE) return y
  const length = node.textContent?.length ?? 0
  if (length === 0) return y
  const range = document.createRange()
  const from = Math.min(offset, length - 1)
  range.setStart(node, from)
  range.setEnd(node, from + 1)
  const rect = [...range.getClientRects()].find((box) => box.height > 0)
  return rect ? rect.top : y
}

/** A place pressed in a message: the text position under it, and its line's top on screen then. */
export interface CaretSpot {
  readonly point: CaretPoint
  readonly top: number
}

/**
 * The spot at (x, y), read when it's pressed: a double-click's first click can move the text
 * (on a narrow screen it shows the message's actions, scrolling them into view), and the
 * position and line read then are the ones the user aimed at.
 */
export function caretSpotAt(x: number, y: number): CaretSpot | null {
  const point = caretFromPoint(x, y)
  return point ? { point, top: lineTop(point, y) } : null
}

/** Where a double-click on `spot` puts the edit's caret in `source`; null where no locator knows. */
export function locateEditCaret(spot: CaretSpot, source: string): EditCaret | null {
  if (!spot.point.node.isConnected) return null
  const locators = [...editCaretLocators.list()].sort((a, b) => a.order - b.order)
  for (const locator of locators) {
    const offset = locator.locate(spot.point, source)
    if (offset !== null) return { offset: Math.min(Math.max(0, offset), source.length), top: spot.top }
  }
  return null
}

/** The body's source map: the renderer's own offsets for the text under the point. */
const sourceMapLocator: EditCaretLocator = {
  id: "edit-caret.source-map",
  order: 0,
  locate: (point, source) => {
    const mapped = sourceOffsetAt(point.node, point.offset)
    return mapped?.text === source ? mapped.offset : null
  }
}

/**
 * The words around the point (`contextOffset`), for a point the map doesn't cover: between
 * paragraphs, in HTML the renderer drew itself. Only in the message's own body, not its thinking.
 */
const contextLocator: EditCaretLocator = {
  id: "edit-caret.context",
  order: 10,
  locate: (point, source) => {
    const found = messageBodyAt(point.node)
    if (!found || found.text !== source) return null
    const before = document.createRange()
    before.selectNodeContents(found.body)
    const after = before.cloneRange()
    before.setEnd(point.node, point.offset)
    after.setStart(point.node, point.offset)
    return contextOffset(source, before.toString(), after.toString())
  }
}

export const registerEditCaret = () => [
  editCaretLocators.register(sourceMapLocator),
  editCaretLocators.register(contextLocator)
]
