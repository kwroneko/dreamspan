// When a streaming disclosure (a reply's Reasoning, its steps) opens and folds by itself (DESIGN
// §7.4). It streams open and folds when the reply arrives, but short content must not flash:
// it opens only once it has been streaming for AUTO_OPEN_AFTER_MS (one that completes sooner
// never opens), and once opened it stays open for at least AUTO_OPEN_MIN_MS before folding.
// A user's own toggle always wins; the callers keep that choice apart from this.
import { useEffect, useRef, useState } from "react"

export const AUTO_OPEN = { afterMs: 600, minOpenMs: 800 } as const

/**
 * Whether the disclosure is open on its own account. `streaming`: the reply is being written;
 * `live`: this disclosure's content is still arriving (a thinking panel stops being live when
 * the text starts); `enabled`: the user prefers them open while streaming. `state` lets two
 * elements of one message (the steps element and its header badge) share one answer.
 */
export function useAutoOpen(
  streaming: boolean,
  live: boolean,
  enabled: boolean,
  state?: readonly [boolean, (open: boolean) => void]
) {
  const own = useState(false)
  const [open, setOpen] = state ?? own
  const latest = useRef({ live, setOpen })
  latest.current = { live, setOpen }
  const openedAt = useRef<number | null>(null)
  useEffect(() => {
    if (streaming && enabled) {
      const timer = setTimeout(() => {
        if (!latest.current.live) return
        openedAt.current = Date.now()
        latest.current.setOpen(true)
      }, AUTO_OPEN.afterMs)
      return () => clearTimeout(timer)
    }
    if (!streaming && openedAt.current === null) {
      // Done, and never opened here (or opened by an element since gone): folded.
      latest.current.setOpen(false)
      return undefined
    }
    if (!streaming && openedAt.current !== null) {
      const wait = Math.max(0, openedAt.current + AUTO_OPEN.minOpenMs - Date.now())
      const timer = setTimeout(() => {
        openedAt.current = null
        latest.current.setOpen(false)
      }, wait)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [streaming, enabled])
  return open
}
