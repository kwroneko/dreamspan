// One cold-prefix writer per owner; SDK callbacks are promises, so the gate uses the
// request's AbortSignal. Its lifetime is the provider attempt, including interruption.
import type { LlmRequestId } from "@rp/shared/usage.ts"

export interface CacheReleasePolicy {
  readonly after: "first-chunk" | "complete"
  readonly timeoutMs: number
}

export const defaultCacheRelease: CacheReleasePolicy = { after: "first-chunk", timeoutMs: 10_000 }

type Release = "first-chunk" | "complete" | "timeout" | "leader-ended"
interface Gate {
  readonly leader: LlmRequestId
  readonly ready: Promise<Release>
  release: (reason: Release) => void
  reason: Release | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

export const makeCacheStagger = () => {
  const gates = new Map<string, Gate>()
  return {
    join(key: string, requestId: LlmRequestId, policy: CacheReleasePolicy) {
      const previous = gates.get(key)
      if (previous) {
        if (previous.reason === undefined && previous.timer === undefined) {
          previous.timer = setTimeout(() => previous.release("timeout"), policy.timeoutMs)
        }
        return {
          leader: previous.leader,
          waiting: previous.reason === undefined,
          wait: (signal: AbortSignal) =>
            new Promise<Release>((resolve, reject) => {
              const abort = () => reject(signal.reason)
              if (signal.aborted) return abort()
              signal.addEventListener("abort", abort, { once: true })
              void previous.ready.then((reason) => {
                signal.removeEventListener("abort", abort)
                resolve(reason)
              })
            }),
          release: (_reason: Release) => {},
          finish: () => {}
        }
      }
      let resolve!: (reason: Release) => void
      const gate: Gate = {
        leader: requestId,
        ready: new Promise<Release>((done) => (resolve = done)),
        reason: undefined,
        timer: undefined,
        release: (reason) => {
          if (gate.reason !== undefined) return
          gate.reason = reason
          clearTimeout(gate.timer)
          resolve(reason)
        }
      }
      gates.set(key, gate)
      return {
        leader: null,
        waiting: false,
        wait: (_signal: AbortSignal) => Promise.resolve<Release>("leader-ended"),
        release: gate.release,
        finish: () => {
          gate.release("leader-ended")
          if (gates.get(key) === gate) gates.delete(key)
        }
      }
    }
  }
}
