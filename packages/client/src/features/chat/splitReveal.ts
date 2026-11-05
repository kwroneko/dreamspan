import { useEffect, useSyncExternalStore, type RefObject } from "react"
import { revealAdded } from "../../ui/reveal.ts"

type Request = { readonly id: string; readonly added: boolean }
let pending: Request | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const requestSplitReveal = (groupId: string, added = false) => {
  pending = { id: groupId, added }
  for (const listener of listeners) listener()
}

/** Observe the rendered row and its viewport: both can be measured after navigation. */
export function useSplitReveal(containerRef: RefObject<HTMLDivElement | null>, selected: string | undefined) {
  const request = useSyncExternalStore(subscribe, () => pending)
  useEffect(() => {
    const container = containerRef.current
    if (!container || !request || selected !== request.id) return
    let frame = 0
    let row: HTMLElement | null = null
    let flashed = false
    let cancelled = false
    const measure = () => {
      frame = 0
      if (cancelled) return
      const button = [...container.querySelectorAll<HTMLElement>('section[aria-label="Chats"] [data-chat-id]')].find(
        (el) => el.dataset.chatId === request.id && el.getAttribute("aria-current") === "page"
      )
      const next = button?.closest<HTMLElement>("[data-fork-row]") ?? null
      if (next !== row) {
        if (row) sizes.unobserve(row)
        row = next
        if (row) sizes.observe(row)
      }
      if (!row || !container.checkVisibility() || container.clientHeight === 0) return
      const viewport = container.getBoundingClientRect()
      const box = row.getBoundingClientRect()
      if (box.height === 0) return
      const top = Math.max(0, viewport.top + container.clientTop)
      const bottom = Math.min(window.innerHeight, viewport.top + container.clientTop + container.clientHeight)
      if (box.top < top) container.scrollTop += box.top - top
      else if (box.bottom > bottom) container.scrollTop += Math.min(box.bottom - bottom, box.top - top)
      if (request.added && !flashed) {
        flashed = true
        revealAdded(row)
      }
    }
    const schedule = () => {
      if (!frame && !cancelled) frame = requestAnimationFrame(measure)
    }
    const sizes = new ResizeObserver(schedule)
    sizes.observe(container)
    const contents = new MutationObserver(schedule)
    contents.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] })
    const cancel = () => {
      cancelled = true
      sizes.disconnect()
      contents.disconnect()
    }
    // Once the user moves the list, later layout changes must not pull it back.
    container.addEventListener("wheel", cancel, { passive: true })
    const pointer = (event: PointerEvent) => {
      if (event.target === container) cancel()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancel()
    }
    container.addEventListener("pointerdown", pointer)
    container.addEventListener("keydown", keyboard)
    schedule()
    return () => {
      cancel()
      cancelAnimationFrame(frame)
      container.removeEventListener("wheel", cancel)
      container.removeEventListener("pointerdown", pointer)
      container.removeEventListener("keydown", keyboard)
    }
  }, [containerRef, request, selected])
}
