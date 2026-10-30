// Where summarized history ends in the message list (DESIGN §8), compared by display position.
import type { PathEntry } from "@rp/shared/chat.ts"
import type { ChatView } from "./session.ts"

/**
 * A message's position on the fork's display path (spec/MESSAGE-INSERT.md §3.2), which the
 * summary cursor and the history start are compared with: its depth in a fork without
 * insertions, and on an entry read without a position.
 */
export const placeOf = (entry: PathEntry) => entry.position ?? entry.depth

/**
 * Where the divider between summarized and verbatim history goes: the index among `entries`
 * it goes before (entries.length: after the last), or null when the loaded window doesn't
 * hold the boundary.
 */
export function boundaryIndex(view: ChatView): number | null {
  const lcm = view.lcm
  if (lcm === null || !lcm.enabled || lcm.leafSlotId !== view.leafSlotId) return null
  const { entries } = view
  if (entries.length === 0) return null
  let at = entries.findIndex((e) => placeOf(e) > (lcm.cursorPosition ?? lcm.cursorDepth))
  if (at < 0) at = entries.length
  // Before the loaded window, or after it with more below: not here.
  if (at === 0 && view.older !== null) return null
  if (at === entries.length && view.newer !== null) return null
  return at
}
