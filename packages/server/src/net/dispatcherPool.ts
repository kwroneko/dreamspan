import type { Dispatcher } from "undici"

/** Bounded route pools. Active responses are never evicted; saturation refuses new routes. */
export const makeDispatcherPool = (cap = 128, idleMs = 60_000, now = Date.now) => {
  const entries = new Map<string, { dispatcher: Dispatcher; active: number; at: number }>()
  const closing = new Set<Promise<unknown>>()
  const close = (dispatcher: Dispatcher) => {
    const pending = dispatcher
      .close()
      .catch(() => {})
      .finally(() => closing.delete(pending))
    closing.add(pending)
  }
  const evict = (key: string) => {
    const entry = entries.get(key)!
    entries.delete(key)
    close(entry.dispatcher)
  }
  return {
    get(key: string, create: () => Dispatcher): Dispatcher {
      const time = now()
      for (const [id, entry] of entries) if (entry.active === 0 && time - entry.at >= idleMs) evict(id)
      const found = entries.get(key)
      if (found) return found.dispatcher
      if (entries.size >= cap) {
        const idle = [...entries].filter(([, entry]) => entry.active === 0).sort((a, b) => a[1].at - b[1].at)[0]
        if (!idle) throw new Error("Too many active network routes")
        evict(idle[0])
      }
      const entry = { dispatcher: create(), active: 0, at: time }
      entry.dispatcher = entry.dispatcher.compose((dispatch) => (options, handler) => {
        entry.active++
        let finished = false
        const release = () => {
          if (finished) return
          finished = true
          entry.active--
          entry.at = now()
        }
        const tracked: Dispatcher.DispatchHandler = {
          onRequestStart: (...args) => handler.onRequestStart?.(...args),
          onResponseStart: (...args) => handler.onResponseStart?.(...args),
          onResponseData: (...args) => handler.onResponseData?.(...args),
          onBodySent: (...args) => handler.onBodySent?.(...args),
          onRequestSent: (...args) => handler.onRequestSent?.(...args),
          onResponseStarted: () => handler.onResponseStarted?.()
        }
        tracked.onResponseEnd = (...args) => {
          release()
          handler.onResponseEnd?.(...args)
        }
        tracked.onResponseError = (...args) => {
          release()
          handler.onResponseError?.(...args)
        }
        tracked.onRequestUpgrade = (...args) => {
          release()
          handler.onRequestUpgrade?.(...args)
        }
        try {
          return dispatch(options, tracked)
        } catch (error) {
          release()
          throw error
        }
      })
      entries.set(key, entry)
      return entry.dispatcher
    },
    async close() {
      for (const key of entries.keys()) evict(key)
      await Promise.allSettled([...closing])
    }
  }
}
