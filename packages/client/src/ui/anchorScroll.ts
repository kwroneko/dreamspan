// A menu opened from a row of a scrolling list closes when that list (or the page around it)
// scrolls, as platform menus do: otherwise it follows its row out of the list and floats over
// whatever is above or below it. Scrolling inside the menu itself never closes it, and a scroll
// event that leaves the trigger where it was (a list nudged to show its active row) is ignored.
// The trigger's place is taken two frames after the menu opens: focusing a half-hidden trigger
// (Tab, then Enter) scrolls its list to show it, and that scroll arrives after the menu opened.
import { type RefObject, useEffect, useRef } from "react"

export function useCloseOnAnchorScroll(open: boolean, trigger: RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const anchor = trigger.current
    if (!open || anchor === null) return
    let start: DOMRect | null = null
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        start = anchor.getBoundingClientRect()
      })
    })
    const onScroll = (event: Event) => {
      const target = event.target
      const scroller = target instanceof Document ? target.documentElement : target instanceof Element ? target : null
      if (start === null || scroller === null) return
      // A virtualized list's row may be gone already: its menu goes with it.
      if (!anchor.isConnected) return latest.current()
      if (!scroller.contains(anchor)) return
      const now = anchor.getBoundingClientRect()
      if (now.top !== start.top || now.left !== start.left) latest.current()
    }
    document.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("scroll", onScroll, { capture: true })
    }
  }, [open, trigger])
}
