import { revealIfHidden } from "./reveal.ts"

/** Reveal after the sticky toolbar has measured any new unsaved bar, then flash the block. */
export function revealAdded(element: HTMLElement, parts: ReadonlyArray<HTMLElement | null | undefined> = []) {
  requestAnimationFrame(() => {
    if (!element.isConnected) return
    revealIfHidden(element, parts)
    element.dataset.revealAdded = "true"
    const animation = element.animate(
      [{ boxShadow: "0 0 0 2px var(--accent)" }, { boxShadow: "0 0 0 2px transparent" }],
      { duration: 450, iterations: 3 }
    )
    animation.onfinish = () => {
      delete element.dataset.revealAdded
    }
  })
}
