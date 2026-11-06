// A message jumped to (owner, 2026-11-06): "It should flash a couple times like when scrolling
// to a specific old message on a chat app, not remain highlighted." Every way of opening a chat
// at a message (a message link, the character's tile, a search or history match, a summary's
// range, the split link, the bin's branch links) ends as the URL's `slot`, and the list then
// flashes that message with the shared flash (ui/reveal.ts `flashItem`), once, and leaves it
// unmarked. A message just inserted flashes the same way.
import type { SlotId } from "@rp/shared/chat.ts"
import { flashItem } from "../../ui/reveal.ts"

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * The message this history entry's jump already flashed (`<chat>/<slot>`): coming back to
     * the entry, reloading it or showing its tab again opens at the message without flashing it.
     */
    chatFlashed?: string
  }
}

/** How long a jump waits for its message to render (a page loading, summaries expanding to it). */
const WAIT_MS = 8000
/** About one flash: a summary's layer replacing the original it first rendered as flashes the new one. */
const SETTLE_MS = 1500
/** How often it looks again while the chat is covered or its tab isn't shown. */
const COVERED_POLL_MS = 250

/**
 * Whether the list can't be seen: its workbench tab isn't shown (taken out of the page), or a
 * modal covers it (a phone's side panel sheet: Base UI hides what's outside it).
 */
const covered = (list: HTMLElement) => !list.isConnected || list.closest('[inert], [aria-hidden="true"]') !== null

/**
 * Flashes the message (or merged chat) `slot` in `list` once it's rendered and can be seen: now,
 * when it mounts, or when what covers the chat closes (opening a character's chat on a phone
 * shows the card's panel over it first). `onFlash` runs when it starts. Returns a cancel.
 */
export function flashWhenShown(list: HTMLElement, slot: SlotId, onFlash?: () => void) {
  const selector = `article[data-slot="${CSS.escape(slot)}"]`
  let flashed: HTMLElement | null = null
  let started = false
  let frame = 0
  let poll: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const attempt = () => {
    if (stopped || (flashed !== null && flashed.isConnected)) return
    const item = list.querySelector<HTMLElement>(selector)
    if (!item || item === flashed) return
    if (covered(list)) {
      // Rendered but not seen: wait for as long as it's covered, without the render limit.
      clearTimeout(timer)
      clearTimeout(poll)
      poll = setTimeout(attempt, COVERED_POLL_MS)
      return
    }
    flashed = item
    cancelAnimationFrame(frame)
    // Once the list has placed it: two frames, as its positioning does (ChatPage.tsx).
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (stopped || !item.isConnected) return
        if (covered(list)) {
          flashed = null
          return attempt()
        }
        flashItem(item)
        if (!started) {
          started = true
          onFlash?.()
          clearTimeout(timer)
          timer = setTimeout(stop, SETTLE_MS)
        }
      })
    })
  }
  const observer = new MutationObserver(attempt)
  observer.observe(list, { childList: true, subtree: true })
  let timer = setTimeout(stop, WAIT_MS)
  function stop() {
    stopped = true
    observer.disconnect()
    clearTimeout(timer)
    clearTimeout(poll)
  }
  attempt()
  return () => {
    stop()
    cancelAnimationFrame(frame)
  }
}
