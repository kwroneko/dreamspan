// What the insertion editor tells the user before they commit (spec/MESSAGE-INSERT.md §4.2): one
// line each, registered, so a plugin can add, replace or disable one. Each reads the open chat's
// view, the message it goes below and the position the new message takes.
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import { makeRegistry } from "../../../registry.ts"
import { lcmCursor, positionOf } from "../position.ts"
import type { ChatView } from "../session.ts"

export interface InsertEstimateContext {
  readonly view: ChatView
  /** The message it goes below; null above the first message. */
  readonly anchor: PathEntry | null
  /** The position the new message takes (0: the first message). */
  readonly position: number
  readonly now: number
}

export interface InsertEstimate {
  readonly id: string
  readonly order: number
  /** The line, or null when it has nothing to say here. */
  readonly line: (context: InsertEstimateContext) => string | null
}

export const insertEstimates = makeRegistry<InsertEstimate>()

/** The position a message inserted below `anchor` takes: directly below it, whatever was inserted there before. */
export const insertPosition = (anchor: PathEntry | null) => (anchor === null ? 0 : positionOf(anchor) + 1)

/** The next reply's recorded history start, when it's the reply to the leaf shown. */
const historyStartOf = (view: ChatView) =>
  view.history?.leafSlotId === view.leafSlotId ? (view.history?.historyStart ?? null) : null

/**
 * The last position the summaries in use cover (-1: none): what's before the history start but
 * summarized reaches the model through its summary, which the next reply rewrites (spec §3.4).
 */
const summarizedThrough = (view: ChatView) => {
  const lcm = view.lcm
  if (lcm !== null && lcm.enabled && lcm.leafSlotId === view.leafSlotId) return lcmCursor(lcm)
  return view.history?.leafSlotId === view.leafSlotId ? (view.history?.summarizedThrough ?? -1) : -1
}

/**
 * Whether the new message comes before the first message the next reply is sent (the stepped
 * history start) and after what summaries cover: the next reply doesn't see it at all.
 */
const beforeHistoryStart = ({ view, position }: InsertEstimateContext) => {
  const start = historyStartOf(view)
  // Its anchor is at `position - 1`: below a summarized message, it joins the summary.
  return start !== null && position <= start.depth && position - 1 > summarizedThrough(view)
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** How many messages the next reply re-reads: the new message, then every message after its anchor; null: all from here, past what's loaded. */
export const rereadCount = ({ view, position }: InsertEstimateContext): number | null => {
  const last = view.newer === null ? view.entries.at(-1) : undefined
  return last === undefined ? null : Math.max(1, positionOf(last) - position + 2)
}

/**
 * "The model will re-read N messages on the next reply (cache: ~X tokens)": from the new message
 * to the end. Shown in the cache chip's popover while the editor is open, not among its lines.
 */
export const cacheLine = (context: InsertEstimateContext): string | null => {
  const { view, now } = context
  if (beforeHistoryStart(context)) return null
  const reread = rereadCount(context)
  const warmth = view.cache
  const warm =
    warmth !== null &&
    warmth.changed === null &&
    warmth.ttlS != null &&
    warmth.expiresAt !== null &&
    now < warmth.expiresAt
  const cache = warm ? `cache: ~${warmth.prefixTokens.toLocaleString()} tokens` : "the cache is cold"
  return reread === null
    ? `The model will re-read every message from here on the next reply (${cache}).`
    : `The model will re-read ${count(reread, "message", "messages")} on the next reply (${cache}).`
}

export const historyStartLine = (context: InsertEstimateContext): string | null =>
  beforeHistoryStart(context) ? "Before the model's history start: the next reply won't see it." : null

/** Whether a summary in use covers the anchor (spec §3.4): it's rewritten on the next reply. */
export const summarizedLine = ({ view, anchor }: InsertEstimateContext): string | null => {
  const lcm = view.lcm
  if (anchor === null || lcm === null || !lcm.enabled || lcm.leafSlotId !== view.leafSlotId) return null
  const at = positionOf(anchor)
  // Summaries' ranges are one-based positions.
  return lcm.layer.some((summary) => at >= summary.from - 1 && at <= summary.to - 1)
    ? "Inside summarized history: the summary is rewritten on the next reply."
    : null
}

export const registerInsertEstimates = () => [
  insertEstimates.register({ id: "insert.history-start", order: 20, line: historyStartLine }),
  insertEstimates.register({ id: "insert.summarized", order: 30, line: summarizedLine })
]
