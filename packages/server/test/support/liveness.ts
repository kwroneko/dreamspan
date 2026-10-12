// A named bound for a step that can only hang if the code under test regressed. The tests
// that use it wait on events, not clocks. Without it, such a regression shows up only as
// vitest's bare "Test timed out". 20 s is far longer than any of these steps takes on a
// loaded host, and still fits inside the 30 s test timeout.
import { Effect } from "effect"

export const stalls =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.timeoutOrElse(effect, {
      duration: "20 seconds",
      orElse: () => Effect.die(new Error(`no progress in 20 s: ${message}`))
    })
