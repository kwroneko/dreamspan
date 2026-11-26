// A streaming disclosure (a reply's Reasoning or steps) waits before opening to avoid flashing
// short content (DESIGN §7.4). Once open, it stays open for a minimum time if the reply finishes.
// Turning off the streaming preference folds it immediately. Callers keep manual choices separately.
import { useEffect, useEffectEvent, useRef, useState } from "react"

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
  const openedAt = useRef<number | null>(null)
  const show = useEffectEvent(() => {
    if (!live) return
    openedAt.current = Date.now()
    setOpen(true)
  })
  const fold = useEffectEvent(() => {
    openedAt.current = null
    setOpen(false)
  })
  useEffect(() => {
    if (streaming) {
      if (!enabled) {
        fold()
        return undefined
      }
      const timer = setTimeout(() => show(), AUTO_OPEN.afterMs)
      return () => clearTimeout(timer)
    }
    if (openedAt.current === null) {
      // Done, and never opened here (or opened by an element since gone): folded.
      fold()
      return undefined
    }
    const wait = Math.max(0, openedAt.current + AUTO_OPEN.minOpenMs - Date.now())
    const timer = setTimeout(() => fold(), wait)
    return () => clearTimeout(timer)
  }, [streaming, enabled])
  return open && (!streaming || enabled)
}
