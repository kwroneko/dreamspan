// An editor opened at a double-click keeps the clicked text where it was on screen: its box and
// every scrolling ancestor (the chat's list, the page) scroll so the caret's line sits at the
// line's old place, kept in view, and again as the layout settles over the next frames (the
// list measures the row the editor grew or shrank), until the user scrolls, types or presses.
import type { EditorView } from "@codemirror/view"

/** How long the layout may take to settle, and how many still frames say it has. */
const SETTLE_MS = 1000
const STEADY_FRAMES = 4
const INPUTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const

/** The element's parent, through a shadow root's host. */
const parentOf = (element: Element): Element | null =>
  element.parentElement ?? ((element.getRootNode() as ShadowRoot).host as Element | undefined) ?? null

const scrolls = (element: Element) => {
  if (element === document.scrollingElement) return element.scrollHeight > element.clientHeight
  const overflow = getComputedStyle(element).overflowY
  return (
    (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
    element.scrollHeight > element.clientHeight
  )
}

/** The visual viewport's top and bottom, in the coordinates boxes are measured in. */
function screen(): { top: number; bottom: number } {
  const viewport = window.visualViewport
  const top = viewport?.offsetTop ?? 0
  return { top, bottom: top + (viewport?.height ?? window.innerHeight) }
}

/** What of the element shows on screen, vertically: its box within the visual viewport. */
function shown(element: Element): { top: number; bottom: number } {
  const { top, bottom } = screen()
  if (element === document.scrollingElement) return { top, bottom }
  const box = element.getBoundingClientRect()
  return { top: Math.max(top, box.top), bottom: Math.min(bottom, box.bottom) }
}

/**
 * Where in the editor's own box the caret's line goes, as a viewport y once the box is in place:
 * as far down the box as `top` is down the screen, so a box shorter than the screen ends up over
 * as much of it as it can with the line at `top`, rather than with the line at one of its edges.
 */
function inBox(box: DOMRect, top: number): number {
  const { top: first, bottom: last } = screen()
  const share = Math.min(1, Math.max(0, (top - first) / Math.max(1, last - first)))
  return box.top + share * box.height
}

/** One pass: each scroller in turn, innermost first. Whether anything moved. */
function place(view: EditorView, top: number): boolean {
  const head = view.state.selection.main.head
  let line = view.coordsAtPos(head)
  if (!line) return false
  let moved = false
  for (let element: Element | null = view.scrollDOM; element && line; element = parentOf(element)) {
    if (!scrolls(element)) continue
    const room = element === view.scrollDOM ? element.getBoundingClientRect() : shown(element)
    const height = line.bottom - line.top
    const aim = element === view.scrollDOM ? inBox(room as DOMRect, top) : top
    const want = Math.min(Math.max(aim, room.top), Math.max(room.top, room.bottom - height))
    const delta = line.top - want
    if (Math.abs(delta) < 1) continue
    const before = element.scrollTop
    element.scrollTop = before + delta
    if (Math.abs(element.scrollTop - before) >= 1) {
      moved = true
      line = view.coordsAtPos(head)
    }
  }
  return moved
}

/**
 * Holds the view's caret line at viewport y `top` while the layout settles; `onScrolled` after
 * each pass that scrolled. The returned function stops it early.
 */
export function holdCaretAt(view: EditorView, top: number, onScrolled?: () => void): () => void {
  let frame = 0
  let steady = 0
  let stopped = false
  const started = performance.now()
  const stop = () => {
    stopped = true
    cancelAnimationFrame(frame)
    for (const event of INPUTS) window.removeEventListener(event, stop, true)
  }
  const pass = () => {
    if (stopped || !view.dom.isConnected) return stop()
    if (place(view, top)) {
      steady = 0
      onScrolled?.()
    } else steady++
    if (steady < STEADY_FRAMES && performance.now() - started < SETTLE_MS) frame = requestAnimationFrame(pass)
    else stop()
  }
  for (const event of INPUTS) window.addEventListener(event, stop, { capture: true, passive: true })
  // From the next frame, once the editor has measured its lines.
  frame = requestAnimationFrame(pass)
  return stop
}
