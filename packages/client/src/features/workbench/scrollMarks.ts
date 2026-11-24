// A tab's scroll positions as an entry of its history keeps them (history.ts `ScrollMark`): each
// scrolled element as its path from the tab's element, so they come back once the page that
// left is shown again (spec/TAB-HISTORY.md §5).
import type { ScrollMark } from "./history.ts"

const MAX_MARKS = 20
/** How long a restore keeps trying while the page loads what it scrolled through. */
const PATIENCE_MS = 3000

/** An element's tag and attribute names: not its classes or values, which change while it loads. */
const whatOf = (element: Element) =>
  [
    element.tagName.toLowerCase(),
    ...element
      .getAttributeNames()
      .filter((name) => name !== "class" && name !== "style" && !name.startsWith("aria-"))
      .sort()
  ].join(" ")

/** The scrolled elements under `root`, outermost first. */
export const scrollMarks = (root: HTMLElement): Array<ScrollMark> => {
  const marks: Array<ScrollMark> = []
  const walk = (element: Element, path: Array<number>) => {
    if (marks.length >= MAX_MARKS) return
    if (element !== root && (element.scrollTop !== 0 || element.scrollLeft !== 0))
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
 * and each element is long enough, trying every animation frame for a while; the user's own
 * scrolling (wheel, touch, a key, a press) stops it. The returned function stops it too.
 */
export const restoreScroll = (root: HTMLElement, marks: ReadonlyArray<ScrollMark>, ready: () => boolean) => {
  if (marks.length === 0) return () => {}
  const until = performance.now() + PATIENCE_MS
  const left = new Set(marks)
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
    for (const mark of left) {
      const element = at(root, mark.path)
      if (!element || whatOf(element) !== mark.what) continue
      const room = element.scrollHeight - element.clientHeight
      const roomX = element.scrollWidth - element.clientWidth
      // Not long enough yet (results still loading): wait for it, as long as there's time.
      if ((room < mark.top - 1 || roomX < mark.left - 1) && performance.now() < until) continue
      element.scrollTop = mark.top
      element.scrollLeft = mark.left
      left.delete(mark)
    }
    if (left.size === 0 || performance.now() >= until) stop()
    else frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return stop
}
