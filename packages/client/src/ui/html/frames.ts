// The chat view's live document-block frames (spec/HTML-MESSAGES.md §3.3): at most eight load
// at once. A frame near the screen claims a slot; when none is free, the frame that left the
// screen longest ago unloads (it keeps its height as a placeholder) and gives its slot up. A
// frame that finds every slot on screen waits for one to leave.

/** At most this many frames are loaded in one chat view. */
export const MAX_LIVE_FRAMES = 8

interface Live {
  onscreen: boolean
  /** When it left the screen: the oldest goes first. */
  since: number
  readonly unload: () => void
}

export class FrameSlots {
  private readonly live = new Map<string, Live>()
  private readonly waiting = new Map<string, () => void>()
  /** Each frame's last reported height, kept for its placeholder while it's unloaded. */
  readonly heights = new Map<string, number>()
  private clock = 0

  private readonly limit: number

  constructor(limit = MAX_LIVE_FRAMES) {
    this.limit = limit
  }

  /** A frame near the screen asks to load; false while every slot holds a frame on screen. */
  claim(id: string, unload: () => void): boolean {
    this.waiting.delete(id)
    const held = this.live.get(id)
    if (held) {
      held.onscreen = true
      return true
    }
    if (this.live.size >= this.limit) {
      let oldest: [string, Live] | undefined
      for (const entry of this.live)
        if (!entry[1].onscreen && (!oldest || entry[1].since < oldest[1].since)) oldest = entry
      if (!oldest) return false
      this.live.delete(oldest[0])
      oldest[1].unload()
    }
    this.live.set(id, { onscreen: true, since: 0, unload })
    return true
  }

  /** A frame waiting for a slot: `retry` runs when one may be free. */
  wait(id: string, retry: () => void) {
    this.waiting.set(id, retry)
  }

  /** It left the screen: it stays loaded until a frame near the screen needs its slot. */
  away(id: string) {
    this.waiting.delete(id)
    const held = this.live.get(id)
    if (!held) return
    held.onscreen = false
    held.since = ++this.clock
    this.wake()
  }

  /** It unmounted, or collapsed. */
  release(id: string) {
    this.waiting.delete(id)
    if (this.live.delete(id)) this.wake()
  }

  /** How many frames are loaded. */
  get size() {
    return this.live.size
  }

  private wake() {
    for (const [id, retry] of [...this.waiting]) {
      this.waiting.delete(id)
      retry()
    }
  }
}
