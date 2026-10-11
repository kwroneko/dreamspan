import { Context, Effect, Layer } from "effect"

const INTERVAL_MS = 10
const BUCKET_MS = 1000
/** The window `sample` covers: a minute of one-second buckets. */
const WINDOW_BUCKETS = 60

export interface EventLoopDelay {
  /** The worst one-second p99 in the window, in ms. */
  readonly p99Ms: number
  /** The longest single delay in the window, in ms. */
  readonly maxMs: number
}

const summarize = (delays: ReadonlyArray<number>): EventLoopDelay => {
  if (delays.length === 0) return { p99Ms: 0, maxMs: 0 }
  const sorted = [...delays].sort((a, b) => a - b)
  return { p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1]!, maxMs: sorted[sorted.length - 1]! }
}

/**
 * Tracks main-thread event-loop delay. Anything that blocks the loop (a synchronous
 * query, a large JSON parse) delays every live stream, so this is a budgeted metric.
 *
 * A 10 ms timer measures how late each tick runs. Node's own monitor
 * (`monitorEventLoopDelay`) isn't used: it discards the first interval after a reset,
 * so a stall starting just after a bucket change went unseen.
 */
export class EventLoopMonitor extends Context.Service<
  EventLoopMonitor,
  {
    /** The delay over the last minute. Reading it changes nothing, so callers don't affect each other. */
    readonly sample: Effect.Effect<EventLoopDelay>
  }
>()("rp/EventLoopMonitor") {
  static readonly layer = Layer.effect(
    EventLoopMonitor,
    Effect.gen(function* () {
      const buckets: Array<EventLoopDelay> = []
      let current: Array<number> = []
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let last = performance.now()
          let bucketStart = last
          const timer = setInterval(() => {
            const now = performance.now()
            current.push(Math.max(0, now - last - INTERVAL_MS))
            last = now
            if (now - bucketStart >= BUCKET_MS) {
              buckets.push(summarize(current))
              if (buckets.length > WINDOW_BUCKETS) buckets.shift()
              current = []
              bucketStart = now
            }
          }, INTERVAL_MS)
          timer.unref()
          return timer
        }),
        (timer) => Effect.sync(() => clearInterval(timer))
      )

      const round = (ms: number) => Math.round(ms * 10) / 10
      return EventLoopMonitor.of({
        sample: Effect.sync(() => {
          const window = [...buckets, summarize(current)]
          return {
            p99Ms: round(Math.max(...window.map((bucket) => bucket.p99Ms))),
            maxMs: round(Math.max(...window.map((bucket) => bucket.maxMs)))
          }
        })
      })
    })
  )
}
