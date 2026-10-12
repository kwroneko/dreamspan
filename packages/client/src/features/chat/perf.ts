// Counters the performance harness reads (CLIENT-FRAMEWORK §7, packages/client/perf/).
// Plain increments, cheap enough to keep in every build.

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
  /** The open chat's window: what the harness reports when a scenario gets stuck. */
  window: { loaded: 0, first: "", older: false, newer: false, paging: false, loading: false, error: "" }
}

/** The versions whose message body is mounted, so an update to one can be told from one off screen. */
export const mountedBodies = new Set<string>()

declare global {
  interface Window {
    __rpPerf?: typeof perf
  }
}

window.__rpPerf = perf
