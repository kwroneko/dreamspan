// A tab's scroll positions as an entry of its history keeps them (history.ts `ScrollMark`): each
// scrolled element as its path from the tab's element, so they come back once the page that
// left is shown again (spec/TAB-HISTORY.md §5).
import type { ScrollMark } from "./history.ts"

const MAX_MARKS = 20
/** How long a restore keeps trying while the page loads what it scrolled through. */
const PATIENCE_MS = 3000
/** Frames a restored element's length must hold still before it's left alone. */
const SETTLED_FRAMES = 20
const PAGE_SCROLL = "data-page-scroll"

/** An element's tag and stable attribute names, also matching scroll marks saved before `PAGE_SCROLL`. */
const whatOf = (element: Element) =>
  [
    element.tagName.toLowerCase(),
    ...element
      .getAttributeNames()
      .filter((name) => name !== "class" && name !== "style" && name !== PAGE_SCROLL && !name.startsWith("aria-"))
      .sort()
  ].join(" ")

/** The scrolled elements and the shared page scroller under `root`, outermost first. */
export const scrollMarks = (root: HTMLElement): Array<ScrollMark> => {
  const marks: Array<ScrollMark> = []
  const walk = (element: Element, path: Array<number>) => {
    if (marks.length >= MAX_MARKS) return
    if (element !== root && (element.scrollTop !== 0 || element.scrollLeft !== 0 || element.hasAttribute(PAGE_SCROLL)))
      marks.push({ path, what: whatOf(element), top: element.scrollTop, left: element.scrollLeft })
    Array.from(element.children).forEach((child, i) => walk(child, [...path, i]))
  }
  walk(root, [])
  return marks
}

const at = (root: Element, path: ReadonlyArray<number>) => {
  let element: Element | undefined = root
  for (const i of path) element = element?.children[i]
  return element
}

/**
 * Puts `marks` back under `root` once the page is there (`ready`, then a frame for it to render)
 * and each element is long enough, trying every animation frame for a while, and again while
 * what loads above moves it, until its length holds still; the user's own scrolling (wheel,
 * touch, a key, a press) stops it. The returned function stops it too.
 */
export const restoreScroll = (root: HTMLElement, marks: ReadonlyArray<ScrollMark>, ready: () => boolean) => {
  if (marks.length === 0) return () => {}
  const until = performance.now() + PATIENCE_MS
  /** Each mark not yet settled: its element's length when last seen, and the frames it held. */
  const left = new Map(marks.map((mark) => [mark, { length: -1, held: 0 }]))
  let frame = 0
  let stopped = false
  let rendered = false
  const stop = () => {
    stopped = true
    cancelAnimationFrame(frame)
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) root.removeEventListener(type, stop)
  }
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
    root.addEventListener(type, stop, { passive: true })
  const tick = () => {
    if (stopped) return
    // The page that left may still be there: wait for the one coming back, and a frame more.
    if (!rendered) {
      rendered = ready()
      if (performance.now() >= until) stop()
      else frame = requestAnimationFrame(tick)
      return
    }
    for (const [mark, seen] of left) {
      const element = at(root, mark.path)
      if (!element || whatOf(element) !== mark.what) continue
      const room = element.scrollHeight - element.clientHeight
      const roomX = element.scrollWidth - element.clientWidth
      // Not long enough yet (results still loading): wait for it, as long as there's time.
      if ((room < mark.top - 1 || roomX < mark.left - 1) && performance.now() < until) continue
      // Put back again while what loads above it moves it (the browser's scroll anchoring),
      // until its length has held still a while.
      if (Math.abs(element.scrollTop - mark.top) > 1) element.scrollTop = mark.top
      if (Math.abs(element.scrollLeft - mark.left) > 1) element.scrollLeft = mark.left
      const length = element.scrollHeight + element.scrollWidth
      seen.held = length === seen.length ? seen.held + 1 : 0
      seen.length = length
      if (seen.held >= SETTLED_FRAMES) left.delete(mark)
    }
    if (left.size === 0 || performance.now() >= until) stop()
    else frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return stop
}
