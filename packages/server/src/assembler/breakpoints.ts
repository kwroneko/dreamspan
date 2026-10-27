// Cache breakpoints, placed structurally, as deltas from reference-harness's scheme (ARCHITECTURE §15).
import type { Stability } from "./st.ts"
import type { AssembledRequest } from "./types.ts"

type Breakpoint = AssembledRequest["breakpoints"][number]

/**
 * The boundaries worth a marker, most important first, since a provider with fewer free
 * markers keeps the first ones:
 * - (c) `history`: the last message before the first volatile one, the end of what the next
 *   request reproduces while the history's start holds;
 * - (a) `prefix`: the end of the leading run of prefix messages, before any pinned lore, the
 *   summary layer or the history: what survives a move of the history's start;
 * - (b) `summary`: the end of the LCM summary layer;
 * - `pinned`: after the last pinned lore, before the history.
 * After a move of the history's start (`moved`), (a) comes first: the history after it is new
 * anyway. While the start holds, (c) comes first and (a) before (b), so that with two markers
 * the prefix still survives the next move.
 */
export const placeBreakpoints = (
  messages: ReadonlyArray<{ readonly kind: Stability; readonly summary?: boolean }>,
  moved = false
): AssembledRequest["breakpoints"] => {
  const firstVolatile = messages.findIndex((m) => m.kind === "volatile")
  const stableEnd = (firstVolatile === -1 ? messages.length : firstVolatile) - 1
  // The leading run of prefix messages: it ends at the first pinned lore, summary or history.
  const firstNotPrefix = messages.findIndex((m) => m.kind !== "prefix")
  const prefixEnd = (firstNotPrefix === -1 ? messages.length : firstNotPrefix) - 1
  const firstHistory = messages.findIndex((m) => m.kind === "history")
  const pinnedEnd = messages.findLastIndex(
    (m, i) => m.kind === "pinned" && i <= stableEnd && (firstHistory === -1 || i < firstHistory)
  )
  const summaryEnd = messages.findLastIndex((m) => m.kind === "summary" || m.summary)
  const history: Breakpoint | null =
    stableEnd >= 0 && messages[stableEnd]!.kind === "history" ? { message: stableEnd, reason: "history" } : null
  const prefix: Breakpoint | null = prefixEnd >= 0 ? { message: prefixEnd, reason: "prefix" } : null
  const summary: Breakpoint | null = summaryEnd >= 0 ? { message: summaryEnd, reason: "summary" } : null
  const pinned: Breakpoint | null = pinnedEnd >= 0 ? { message: pinnedEnd, reason: "pinned" } : null
  const ordered = moved ? [prefix, history, summary, pinned] : [history, prefix, summary, pinned]
  const breakpoints: Array<Breakpoint> = []
  for (const breakpoint of ordered)
    if (breakpoint && !breakpoints.some((b) => b.message === breakpoint.message)) breakpoints.push(breakpoint)
  return breakpoints
}
