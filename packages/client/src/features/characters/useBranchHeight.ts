import { useLayoutEffect, useRef, useState } from "react"

/** Same account/device lifetime as column widths; a smaller window only clamps the rendered size. */
export function useBranchHeight(
  userId: string,
  active: boolean,
  section: "branch" | "split" = "branch",
  shared = false
) {
  const key = `rp.${section}Height.${userId}`
  const ref = useRef<HTMLElement>(null)
  const [available, setAvailable] = useState(0)
  const [budget, setBudget] = useState(0)
  const [saved, setSaved] = useState<number | null>(() => {
    try {
      const value = Number(localStorage.getItem(key))
      return Number.isFinite(value) && value > 0 ? value : null
    } catch {
      return null
    }
  })
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const measure = () => {
      const list = parent.querySelector<HTMLElement>("[data-shell-list]")
      const row = list?.querySelector<HTMLElement>("[data-fork-row]")
      const total = parent.clientHeight
      // Reserve three ordinary chat rows (including their gaps), plus the controls
      // above the list. Foot headers remain part of the capped section heights.
      const controls = list ? list.getBoundingClientRect().top - parent.getBoundingClientRect().top : 0
      const sections = [...parent.querySelectorAll<HTMLElement>(":scope > section")]
      const headers = sections
        .filter((el) => !el.querySelector("[data-fork-row]"))
        .reduce((sum, el) => sum + el.offsetHeight, 0)
      const gaps = sections.length * (parseFloat(getComputedStyle(parent).rowGap) || 0)
      setAvailable(total)
      setBudget(Math.max(0, total - controls - headers - gaps - 3 * ((row?.offsetHeight ?? 100) + 4)))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    const content = new MutationObserver(measure)
    content.observe(parent, { childList: true, subtree: true })
    measure()
    return () => {
      observer.disconnect()
      content.disconnect()
    }
  }, [active])
  // Both foot sections together use at most 40%, leaving the list and its controls
  // the remaining 60%. Stored heights are caps, never reserved empty space.
  const max = Math.max(0, Math.min(available * (shared ? 0.2 : 0.4), budget / (shared ? 2 : 1)))
  const min = Math.min(80, max)
  const height = Math.max(min, Math.min(max, saved ?? 544))
  const save = (value: number | null) => {
    setSaved(value)
    try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, String(value))
    } catch {
      // Remains usable without browser storage.
    }
  }
  return {
    ref,
    height,
    min,
    max,
    change: (next: number) => save(Math.round(Math.max(min, Math.min(max, next)))),
    reset: () => save(null)
  }
}
