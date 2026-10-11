import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { EventLoopMonitor } from "../src/eventLoop.ts"

const block = (ms: number) =>
  Effect.sync(() => {
    const until = performance.now() + ms
    while (performance.now() < until);
  })

describe("event-loop monitor", () => {
  it.live(
    "a single block shows for the whole window, however often it's read",
    () =>
      Effect.gen(function* () {
        const monitor = yield* EventLoopMonitor
        yield* Effect.sleep(1500)
        yield* monitor.sample
        yield* block(300)
        yield* Effect.sleep(50)
        const first = yield* monitor.sample
        assert.isAbove(first.maxMs, 250, `max ${first.maxMs} ms`)
        // Another reader doesn't reset it, and it outlives the bucket it fell in.
        yield* monitor.sample
        yield* Effect.sleep(1200)
        const later = yield* monitor.sample
        assert.isAbove(later.maxMs, 250, `max ${later.maxMs} ms`)
      }).pipe(Effect.provide(EventLoopMonitor.layer)),
    10_000
  )

  for (const offsetMs of [2, 10, 25]) {
    it.live(
      `a block ${offsetMs} ms after a bucket change shows`,
      () =>
        Effect.gen(function* () {
          const start = performance.now()
          const monitor = yield* EventLoopMonitor
          // Buckets change every second from when the monitor starts.
          yield* Effect.sleep(Math.max(0, start + 1000 + offsetMs - performance.now()))
          yield* block(300)
          yield* Effect.sleep(50)
          const delay = yield* monitor.sample
          assert.isAbove(delay.maxMs, 250, `max ${delay.maxMs} ms`)
        }).pipe(Effect.provide(EventLoopMonitor.layer)),
      10_000
    )
  }
})
