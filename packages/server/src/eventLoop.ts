import { monitorEventLoopDelay } from "node:perf_hooks"
import { Context, Effect, Layer } from "effect"

const RESOLUTION_MS = 10
const BUCKET_MS = 1000
/** The window `sample` covers: a minute of one-second buckets. */
const WINDOW_BUCKETS = 60

export interface EventLoopDelay {
  /** The worst one-second p99 in the window, in ms. */
  readonly p99Ms: number
  /** The longest single delay in the window, in ms. */
  readonly maxMs: number
}

/**
 * Tracks main-thread event-loop delay. Anything that blocks the loop (a synchronous
 * query, a large JSON parse) delays every live stream, so this is a budgeted metric.
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
      const histogram = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
          histogram.enable()
          return histogram
        }),
        (histogram) => Effect.sync(() => histogram.disable())
      )
      // The histogram records whole timer intervals; subtracting the interval leaves the
      // delay added by work on the loop.
      const added = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS)
      const current = (): EventLoopDelay =>
        histogram.count === 0
          ? { p99Ms: 0, maxMs: 0 }
          : { p99Ms: added(histogram.percentile(99)), maxMs: added(histogram.max) }

      const buckets: Array<EventLoopDelay> = []
      yield* Effect.sleep(BUCKET_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            buckets.push(current())
            if (buckets.length > WINDOW_BUCKETS) buckets.shift()
            histogram.reset()
          })
        ),
        Effect.forever,
        Effect.forkScoped
      )

      const round = (ms: number) => Math.round(ms * 10) / 10
      return EventLoopMonitor.of({
        sample: Effect.sync(() => {
          const window = [...buckets, current()]
          return {
            p99Ms: round(Math.max(...window.map((bucket) => bucket.p99Ms))),
            maxMs: round(Math.max(...window.map((bucket) => bucket.maxMs)))
          }
        })
      })
    })
  )
}
