// Bringing something just added into view (owner, 2026-11-02): "It should only scroll if
// needed." A new lorebook entry or prompt usually appears where the user is looking, so the
// page stays put; only when its header (or the field that gets the cursor) is hidden, under a
// sticky toolbar, above or below the view, does it scroll, and then the whole header comes
// into view just under the toolbars.

/** The nearest ancestor that scrolls vertically; null: the page itself. */
const scrollParentOf = (element: HTMLElement | null): HTMLElement | null => {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent
  }
  return null
}

/** The room above it: the editors' measured sticky toolbar (`--preset-toolbar-height`, with its gap), or a little. */
const toolbarRoom = (element: HTMLElement) => {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue("--preset-toolbar-height"))
  return Number.isFinite(value) ? value : 16
}

/** The part of the screen `scroller` (or the page) shows, below its sticky toolbar. */
const viewOf = (element: HTMLElement, scroller: HTMLElement | null) => {
  const screen = window.visualViewport
  const screenTop = screen ? screen.offsetTop : 0
  const screenBottom = screen ? screen.offsetTop + screen.height : window.innerHeight
  const box = scroller?.getBoundingClientRect()
  const room = toolbarRoom(element)
  return {
    room,
    // The toolbar's own gap below it doesn't hide anything.
    top: Math.max(box?.top ?? 0, screenTop) + Math.max(0, room - 16),
    bottom: Math.min(box?.bottom ?? Infinity, screenBottom)
  }
}

/** Whether `elements` are all wholly in view, below the sticky toolbars. */
const inView = (...elements: ReadonlyArray<HTMLElement>) =>
  elements.every((element) => {
    const view = viewOf(element, scrollParentOf(element))
    const rect = element.getBoundingClientRect()
    return rect.top >= view.top && rect.bottom <= view.bottom
  })

/**
 * Scrolls only if `header` or any of `parts` (the field that gets the cursor) isn't wholly in
 * view; then the whole header comes into view just under the sticky toolbars. Returns whether
 * it scrolled.
 */
export function revealIfHidden(header: HTMLElement, parts: ReadonlyArray<HTMLElement | null | undefined> = []) {
  const shown = parts.filter((part): part is HTMLElement => part instanceof HTMLElement)
  if (inView(header, ...shown)) return false
  const scroller = scrollParentOf(header)
  const view = viewOf(header, scroller)
  const delta = header.getBoundingClientRect().top - (view.top + Math.min(view.room, 16))
  if (scroller) scroller.scrollTop += delta
  else window.scrollBy(0, delta)
  return true
}

/**
 * What an "Add <thing>" button calls on the item it added (owner, 2026-11-02): the whole item
 * scrolled into view, its header included (only as far as needed; an item taller than the view
 * shows from its header down), then its box flashes a few times so the user sees which one it
 * is. With reduced motion it doesn't flash: a steady highlight fades instead.
 */
export function revealAdded(item: HTMLElement) {
  const reveal = () => {
    if (!inView(item)) {
      const scroller = scrollParentOf(item)
      const view = viewOf(item, scroller)
      const rect = item.getBoundingClientRect()
      const top = view.top + Math.min(view.room, 16)
      // Fits: scroll just enough for its bottom (or its top) to show; else its top at the top.
      const delta =
        rect.height <= view.bottom - top
          ? rect.top < top
            ? rect.top - top
            : rect.bottom - view.bottom + 8
          : rect.top - top
      if (scroller) scroller.scrollTop += delta
      else window.scrollBy(0, delta)
    }
  }
  reveal()
  // A newly mounted text editor can grow after its first frame: keep the whole box in view
  // while it settles, without restarting the flash.
  const growing = new ResizeObserver(reveal)
  growing.observe(item)
  setTimeout(() => growing.disconnect(), 1000)
  flash(item)
}

/** The box flashing: an accent ring three times, or one fading highlight with reduced motion. */
function flash(element: HTMLElement) {
  if (typeof element.animate !== "function") return
  const ring = "inset 0 0 0 2px var(--color-accent)"
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  element.dataset.flashing = ""
  const animation = reduced
    ? element.animate(
        [{ boxShadow: ring }, { boxShadow: ring, offset: 0.6 }, { boxShadow: "inset 0 0 0 2px transparent" }],
        {
          duration: 1600,
          easing: "ease-out"
        }
      )
    : element.animate(
        [
          { boxShadow: "inset 0 0 0 2px transparent" },
          { boxShadow: ring },
          { boxShadow: "inset 0 0 0 2px transparent" }
        ],
        {
          duration: 450,
          iterations: 3,
          easing: "ease-in-out"
        }
      )
  animation.onfinish = animation.oncancel = () => delete element.dataset.flashing
}
