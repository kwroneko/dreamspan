// Counters read by scripts/measure.ts through window.__perf.

export interface PerfState {
  renders: number
  rowUpdates: number
  batches: number
  deltas: number
  recording: boolean
  frames: Array<number>
}

export const perf: PerfState = { renders: 0, rowUpdates: 0, batches: 0, deltas: 0, recording: false, frames: [] }

declare global {
  interface Window {
    __perf: PerfState
    __ready: boolean
    __startStreams: (tokensPerSecond: number, tokens: number) => Promise<void>
    __stopAll: () => Promise<void>
  }
}

window.__perf = perf
window.__ready = false

let last = 0
const tick = (now: number) => {
  if (perf.recording && last > 0) perf.frames.push(now - last)
  last = now
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
