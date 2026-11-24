// A menu opened from a row of a scrolling list closes once scrolling takes its row out of the
// list's visible area: otherwise it follows its row out of the list and floats over whatever is
// above or below it. A scroll that leaves the row whole in view keeps the menu (a chat following
// a reply as it streams), as does one that brings the row further into view (a half-hidden row
// focused from the keyboard, its list scrolling to show it, smoothly or not). Scrolling inside
// the menu itself never closes it.
import { type RefObject, useEffect, useRef } from "react"

/** How much of `row` lies outside the part of `scroller` its content shows in, in pixels. */
const clipped = (row: DOMRect, scroller: Element) => {
  let top = 0
  let bottom = window.innerHeight
  if (scroller !== document.documentElement) {
    const box = scroller.getBoundingClientRect()
    top = box.top + scroller.clientTop
    bottom = top + scroller.clientHeight
  }
  return Math.max(0, top - row.top) + Math.max(0, row.bottom - bottom)
}

export function useCloseOnAnchorScroll(open: boolean, trigger: RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const anchor = trigger.current
    if (!open || anchor === null) return
    // The least clipping seen in each scroller since the menu opened.
    const hidden = new Map<Element, number>()
    const row = anchor.getBoundingClientRect()
    for (let at = anchor.parentElement; at !== null; at = at.parentElement) hidden.set(at, clipped(row, at))
    const onScroll = (event: Event) => {
      const target = event.target
      const scroller = target instanceof Document ? target.documentElement : target instanceof Element ? target : null
      if (scroller === null) return
      // A virtualized list's row may be gone already: its menu goes with it.
      if (!anchor.isConnected) return latest.current()
      if (!scroller.contains(anchor)) return
      const now = clipped(anchor.getBoundingClientRect(), scroller)
      const before = hidden.get(scroller) ?? now
      hidden.set(scroller, Math.min(before, now))
      // A pixel's slack for rounding.
      if (now > before + 1) latest.current()
    }
    document.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => document.removeEventListener("scroll", onScroll, { capture: true })
  }, [open, trigger])
}
