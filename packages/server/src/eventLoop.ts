import { monitorEventLoopDelay } from "node:perf_hooks"
import { Context, Effect, Layer } from "effect"

const RESOLUTION_MS = 10

/**
 * Tracks main-thread event-loop delay. Anything that blocks the loop (a synchronous
 * query, a large JSON parse) delays every live stream, so this is a budgeted metric.
 */
export class EventLoopMonitor extends Context.Service<
  EventLoopMonitor,
  {
    /** p99 delay in ms since the previous call, then resets the histogram. */
    readonly sampleP99Ms: Effect.Effect<number>
  }
>()("rp/EventLoopMonitor") {
  static readonly layer = Layer.effect(
    EventLoopMonitor,
    Effect.acquireRelease(
      Effect.sync(() => {
        const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
        histogram.enable()
        return histogram
      }),
      (histogram) => Effect.sync(() => histogram.disable())
    ).pipe(
      Effect.map((histogram) =>
        EventLoopMonitor.of({
          sampleP99Ms: Effect.sync(() => {
            // The histogram records whole timer intervals; subtract the interval itself so
            // the value is the delay added by work on the loop.
            const p99 = histogram.count > 0 ? Math.max(0, histogram.percentile(99) / 1e6 - RESOLUTION_MS) : 0
            histogram.reset()
            return Math.round(p99 * 10) / 10
          })
        })
      )
    )
  )
}
