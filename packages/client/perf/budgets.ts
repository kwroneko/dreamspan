// What the harness fails on. Set from runs on the shared 48-core host at load averages
// of 40 to 90 (see ARCHITECTURE §10), with headroom for that load: a regression that
// matters crosses these by far more than the host's noise.
export const budgets = {
  /** From navigation to the last message on screen. */
  openBottomMs: 8000,
  /** From navigation to a message 70,000 from the end centered on screen. */
  openDeepMs: 8000,
  /** Long animation frames over 100 ms in any streaming scenario. */
  longFramesOver100: 3,
  /** 95th percentile of frame intervals while six streams run. */
  frameP95Ms: 50,
  /** 95th percentile of input event durations (Event Timing: until the next paint). */
  inputP95Ms: 250,
  /** How far a message on screen may move when older history is prepended, in pixels. */
  anchorErrorPx: 2,
  /** How far a message on screen may move while replies grow below it, in pixels. */
  streamDriftPx: 2,
  /** Message bodies rendered per streamed update: exactly the row that changed. */
  bodyRendersPerUpdate: 1,
  /** Message rows rendered while only text streams: none. */
  rowRendersWhileStreaming: 0,
  /** Heap growth after scrolling the whole long chat, after garbage collection. */
  heapGrowthMb: 40,
  /** Heap after scrolling the whole long chat. */
  heapMb: 150,
  /** The server's worst one-second p99 of event-loop delay over the streaming scenario's last minute. */
  serverLoopP99Ms: 50,
  /** Deltas that arrived past the text a client had: none, ever. */
  gaps: 0
}
