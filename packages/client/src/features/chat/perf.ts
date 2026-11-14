// Counters the performance harness reads (CLIENT-FRAMEWORK §7, packages/client/perf/).
// Built in only when VITE_PERF=1 at build time, as `npm run test:perf` builds: otherwise
// PERF is false, every use below is dead code, and the bundle has neither the counters
// nor window.__rpPerf.
import { useEffect } from "react"

export const PERF = import.meta.env.VITE_PERF === "1"

export const perf = {
  /** Event batches and deltas received. */
  batches: 0,
  deltas: 0,
  /** Live-text updates applied: one per streaming version per frame at most. */
  rowUpdates: 0,
  /** Of those, the updates to a version whose body is on screen. */
  shownUpdates: 0,
  /** Deltas that started past the known text, which a correct server never sends. */
  gaps: 0,
  /** Renders of message bodies, of those showing live text, of message rows, and of the list. */
  bodyRenders: 0,
  liveBodyRenders: 0,
  rowRenders: 0,
  listRenders: 0,
  /** Display-copy worker calls answered, the slowest (ms, send to answer) and the longest queue. */
  displayCalls: 0,
  displayCallMaxMs: 0,
  displayQueueMax: 0,
  /** Each answered call's time in ms, newest last, the last 5,000. */
  displayCallMs: [] as number[],
  /** The open chat's window: what the harness reports when a scenario gets stuck. */
  window: { loaded: 0, first: "", older: false, newer: false, paging: false, loading: false, error: "" }
}

/** The versions whose message body is mounted, so an update to one can be told from one off screen. */
export const mountedBodies = new Set<string>()

type RenderCounter = "bodyRenders" | "liveBodyRenders" | "rowRenders" | "listRenders"

function useCountRenders(counter: RenderCounter, also?: RenderCounter) {
  useEffect(() => {
    perf[counter]++
    if (also) perf[also]++
  })
}

function useMountedBody(versionId: string) {
  useEffect(() => {
    mountedBodies.add(versionId)
    return () => {
      mountedBodies.delete(versionId)
    }
  }, [versionId])
}

const noop = () => {}

/** Counts every render of the calling component in `counter`, and in `also` when given. */
export const useRenderCount: (counter: RenderCounter, also?: RenderCounter) => void = PERF ? useCountRenders : noop

/** Keeps a message body in `mountedBodies` while it's mounted. */
export const useMountedTracking: (versionId: string) => void = PERF ? useMountedBody : noop

declare global {
  interface Window {
    __rpPerf?: typeof perf
  }
}

if (PERF) window.__rpPerf = perf
