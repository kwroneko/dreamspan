// What the harness fails on. Set from runs on the shared 48-core host at load averages
// of 30 to 90 (see ARCHITECTURE §12), with headroom for that load: a regression that
// matters crosses these by far more than the host's noise.
export const budgets = {
  /** From navigation to the last message on screen. */
  openBottomMs: 8000,
  /** From navigation to a message 70,000 from the end centered on screen. */
  openDeepMs: 8000,
  /** Long animation frames over 100 ms while six streams run, or while swiping. */
  longFramesOver100: 3,
  /** Long animation frames over 100 ms while opening a chat or switching chats (measured 2 to 4). */
  navigationLongFramesOver100: 8,
  /** The full scroll, a page of older history landing about every 100 ms (measured 33 ms and 3 to 5). */
  scrollFrameP95Ms: 70,
  scrollLongFramesOver100: 40,
  /** 95th percentile of frame intervals while six streams run. */
  frameP95Ms: 50,
  /** 95th percentile of input event durations (Event Timing: until the next paint). */
  inputP95Ms: 250,
  /** How far a message on screen may move when older history is prepended, in pixels. */
  anchorErrorPx: 2,
  /**
   * How far from the end the list may get while the last reply grows at the bottom, sampled
   * every 200 ms: a frame's growth at most before it follows.
   */
  pinnedPx: 120,
  /** How far a message on screen may move while replies grow below it, in pixels. */
  streamDriftPx: 2,
  /** Renders of streaming bodies on screen per update to one of them: exactly the row that changed. */
  bodyRendersPerUpdate: 1,
  /** List renders per update to a body on screen: measured 0.5 to 0.7, as rows grow and are re-measured. */
  listRendersPerUpdate: 1.5,
  /** Message rows, and bodies not streaming, rendered while only text streams: none. */
  rowRendersWhileStreaming: 0,
  /**
   * Main-thread script time while one reply past 4,000 tokens streams on, per second
   * (measured 130 to 150): rendering more than the last block would cross it.
   */
  longReplyScriptMsPerSecond: 400,
  /** Heap growth after scrolling the whole long chat, after garbage collection. */
  heapGrowthMb: 40,
  /** Heap after scrolling the whole long chat. */
  heapMb: 150,
  /** The 99th percentile round trip of a trivial RPC while six streams run: the server's loop is free. */
  serverRoundTripP99Ms: 100,
  /** Deltas that arrived past the text a client had: none, ever. */
  gaps: 0,
  /**
   * Switching the chat panel's tabs (night/tabperf): message rows re-rendered by a switch (none:
   * the tab is the panel's business), tabs that showed "Loading the …" while their code came
   * (none: it's loaded once the panel opens), and from the click to the tab's content shown with
   * its data, the slowest tab's first visit. That one waits on the server's reads, so it follows
   * the host's load: 337 ms at a load of 40 (master 803 ms), 2.7 to 2.9 s at 110 (Notes; master
   * 1.5 s at 100). The first two are the guards; this one only catches a tab that hangs.
   */
  rowRendersPerTabSwitch: 0,
  tabCodeWaits: 0,
  tabShownMs: 6000,
  /** From navigation to an editor ready, for a 50 KB card or a 100-prompt preset. */
  editorOpenMs: 8000,
  /** Typing into a 20,000 character message being edited (editStyle.perf.ts), per keystroke: the styling's own page script. */
  editStylingMsPerKey: 4,
  /** All the page's script per keystroke there: the editor, the draft, the styling. */
  editScriptMsPerKey: 16,
  /** From a key event to the frame after its paint, 95th percentile. */
  editKeyToPaintP95Ms: 50,
  /** Typing into a 20,000 character draft in the composer (composerStyle.perf.ts), the same three. */
  composerStylingMsPerKey: 4,
  composerScriptMsPerKey: 16,
  composerKeyToPaintP95Ms: 50
}
