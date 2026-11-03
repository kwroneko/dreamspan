// Showing what was just added (owner, 2026-11-02): "an action that adds an item scrolls it
// fully into view (its header too) and flashes its box a few times so the user sees which one
// it is". A local stand-in for the shared `revealAdded` the lorebook job is adding to ui/;
// once that is on master, callers switch to it and this file goes.
import { revealIfHidden } from "../../ui/reveal.ts"

/** How the box flashes: an accent ring, three times. */
const FLASHES = 3
const FLASH_MS = 1200
/** How long it keeps it in view while its contents settle. */
const SETTLE_MS = 1000

/** Scrolls `box` into view (its `header` first, when it's taller than the view), then flashes it. */
export function revealAdded(box: HTMLElement, header: HTMLElement | null = box) {
  const reveal = () =>
    revealIfHidden(header ?? box, [box.getBoundingClientRect().height <= window.innerHeight ? box : null])
  reveal()
  // Its text box can still be growing as its editor loads: follow it for a moment.
  const growing = new ResizeObserver(reveal)
  growing.observe(box)
  setTimeout(() => growing.disconnect(), SETTLE_MS)
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const ring = "0 0 0 3px var(--accent)"
  const none = "0 0 0 3px transparent"
  box.dataset["revealed"] = ""
  const animation = box.animate(
    reduced
      ? [{ boxShadow: ring }, { boxShadow: ring }]
      : [{ boxShadow: none }, { boxShadow: ring }, { boxShadow: none }],
    { duration: reduced ? FLASH_MS : FLASH_MS / FLASHES, iterations: reduced ? 1 : FLASHES, easing: "ease-in-out" }
  )
  animation.onfinish = () => delete box.dataset["revealed"]
}
