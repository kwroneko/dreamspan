import { Effect } from "effect"

/**
 * Logs storage operations that run longer than the budget. A write holds the writer
 * for its whole duration, so a slow one delays every other write.
 */
const SLOW_OPERATION_MS = 25

export const timed =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const start = performance.now()
      return effect.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            const ms = performance.now() - start
            return ms > SLOW_OPERATION_MS
              ? Effect.logWarning(`slow storage operation ${operation}: ${ms.toFixed(1)} ms`)
              : Effect.void
          })
        )
      )
    })
