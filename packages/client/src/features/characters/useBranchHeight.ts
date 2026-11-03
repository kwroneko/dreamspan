import { useLayoutEffect, useRef, useState } from "react"

/** Same account/device lifetime as column widths; a smaller window only clamps the rendered size. */
export function useBranchHeight(userId: string, active: boolean) {
  const key = `rp.branchHeight.${userId}`
  const ref = useRef<HTMLElement>(null)
  const [available, setAvailable] = useState(0)
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
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.height)
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [active])
  const min = Math.min(112, available * 0.4)
  // Leave room for the tabs, scope and search controls and at least one full chat row.
  const max = Math.max(min, available - 224)
  const height = Math.max(min, Math.min(max, saved ?? available * 0.45))
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
