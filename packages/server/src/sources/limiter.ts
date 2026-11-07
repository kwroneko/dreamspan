// The server limits itself (spec/CARD-SOURCES.md §5.5): a token bucket per source for the
// whole instance, `Retry-After` honoured with exponential backoff to 5 minutes, and identical
// concurrent requests sharing one upstream request, dropped when nobody waits on it any more.
import { SourceFailed } from "@rp/shared/cardSources.ts"
import { Effect, Exit, Fiber } from "effect"

export const DEFAULT_RATE = { perSecond: 2, burst: 8 } as const
const MAX_BACKOFF_MS = 5 * 60_000
/** A request waits this long at most for a token, then fails as rate limited. */
const MAX_WAIT_MS = 5_000

interface Bucket {
  tokens: number
  at: number
  blockedUntil: number
  strikes: number
}

export interface Limiter {
  /** Takes a token for `sourceId`, waiting briefly for one; fails while the source holds us back. */
  readonly take: (
    sourceId: string,
    rate: { readonly perSecond: number; readonly burst: number }
  ) => Effect.Effect<void, SourceFailed>
  /** A 429: wait `retryAfterMs` (when given) or back off, doubling on each one in a row. */
  readonly limited: (sourceId: string, retryAfterMs: number | undefined) => number
  /** A request got through: the backoff starts over. */
  readonly passed: (sourceId: string) => void
}

export const makeLimiter = (now: () => number = Date.now): Limiter => {
  const buckets = new Map<string, Bucket>()
  const bucket = (id: string, burst: number) => {
    let b = buckets.get(id)
    if (!b) {
      b = { tokens: burst, at: now(), blockedUntil: 0, strikes: 0 }
      buckets.set(id, b)
    }
    return b
  }
  const blocked = (sourceId: string, retryAfterMs: number) =>
    new SourceFailed({
      sourceId,
      reason: "rate_limited",
      retryAfterMs,
      message: `${sourceId} is limiting requests`
    })
  const take: Limiter["take"] = (sourceId, rate) =>
    Effect.suspend(() => {
      const b = bucket(sourceId, rate.burst)
      const t = now()
      if (b.blockedUntil > t) return Effect.fail(blocked(sourceId, b.blockedUntil - t))
      b.tokens = Math.min(rate.burst, b.tokens + ((t - b.at) / 1000) * rate.perSecond)
      b.at = t
      if (b.tokens >= 1) {
        b.tokens -= 1
        return Effect.void
      }
      const waitMs = Math.ceil(((1 - b.tokens) / rate.perSecond) * 1000)
      if (waitMs > MAX_WAIT_MS) return Effect.fail(blocked(sourceId, waitMs))
      // Reserve the token now, so waiters queue in order rather than all waking for one token.
      b.tokens -= 1
      return Effect.sleep(waitMs)
    })
  return {
    take,
    limited: (sourceId, retryAfterMs) => {
      const b = bucket(sourceId, DEFAULT_RATE.burst)
      b.strikes += 1
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (b.strikes - 1))
      const delay = Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs ?? 0, backoff))
      b.blockedUntil = now() + delay
      return delay
    },
    passed: (sourceId) => {
      const b = buckets.get(sourceId)
      if (b) b.strikes = 0
    }
  }
}

interface Shared {
  readonly fiber: Fiber.Fiber<unknown, unknown>
  waiters: number
}

/**
 * Identical concurrent requests share one run of `make`. A caller that's interrupted (a
 * superseded search) leaves it; when the last one leaves, the upstream request is dropped.
 */
export const makeCoalescer = () => {
  const inFlight = new Map<string, Shared>()
  const run = <A, E, R>(key: string, make: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      let shared = inFlight.get(key)
      if (!shared) {
        const fiber = yield* Effect.forkDetach(
          make.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (inFlight.get(key) === shared) inFlight.delete(key)
              })
            )
          )
        )
        shared = { fiber: fiber as Fiber.Fiber<unknown, unknown>, waiters: 0 }
        inFlight.set(key, shared)
      }
      const own = shared
      own.waiters += 1
      return yield* (Fiber.join(own.fiber) as Effect.Effect<A, E>).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            own.waiters -= 1
            if (own.waiters > 0 || !Exit.hasInterrupts(exit)) return Effect.void
            if (inFlight.get(key) === own) inFlight.delete(key)
            return Effect.asVoid(Effect.forkDetach(Fiber.interrupt(own.fiber)))
          })
        )
      )
    })
  return { run, size: () => inFlight.size }
}
