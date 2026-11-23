// Where the timeline's history lines go (ARCHITECTURE §12 "Context membership"): the size line
// right below the last message the context budget left out, and the hidden line right above
// the first message sent after messages hidden from the model. Each says only its own reason:
// a chat whose first sent message follows a hidden run, with nothing cut for size, gets the
// hidden line alone (owner, 2026-11-23: an imported ST chat hidden up to its summary showed the
// size line, blaming a context of 60k tokens out of 800k).
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import type { ChatView } from "./session.ts"
import { placeOf } from "./summaryBoundary.ts"

export interface HistoryLines {
  /** The index among the entries the size line goes before (entries.length: after the last); -1: none. */
  readonly size: number
  /** The same for the hidden line; -1: none. */
  readonly hidden: number
}

const NONE: HistoryLines = { size: -1, hidden: -1 }

/**
 * Where the line about the messages before position `at` goes: before the first loaded entry at
 * or after it, when the one above it is loaded too or it's exactly at `at` (the window's top);
 * after the last when every loaded entry is above it and the window reaches the leaf.
 */
const lineBefore = (entries: ReadonlyArray<PathEntry>, at: number, atLeaf: boolean) => {
  const first = entries.findIndex((e) => placeOf(e) >= at)
  if (first < 0) return atLeaf ? entries.length : -1
  return first > 0 || placeOf(entries[first]!) === at ? first : -1
}

/** The history lines of `view`; `through`: the last summarized position (null: none). */
export const historyLines = (view: ChatView, through: number | null): HistoryLines => {
  const { entries } = view
  const history = view.history
  const budget = history?.budget
  const start = history?.historyStart
  if (!budget || !history || entries.length === 0) return NONE
  const atLeaf = view.newer === null
  const floor = through ?? -1
  if (start && start.cutThrough !== undefined) {
    const size =
      start.cutThrough !== null && start.cutThrough > floor ? lineBefore(entries, start.cutThrough + 1, atLeaf) : -1
    const hidden =
      start.hiddenBefore !== undefined && start.hiddenBefore !== null && start.hiddenBefore > floor
        ? lineBefore(entries, start.hiddenBefore, atLeaf)
        : -1
    if (size < 0 && hidden < 0 && budget.nonHistoryTokens + budget.responseReserve > budget.maximum && atLeaf)
      return { size: entries.length, hidden: -1 }
    return { size, hidden: hidden === size ? -1 : hidden }
  }
  // A context read without the gap (an older server): every message above the start counts as cut.
  const outOfContext = (entry: PathEntry) =>
    !entry.contextExcluded && start != null && placeOf(entry) < start.depth && placeOf(entry) > floor
  if (start && (entries.some(outOfContext) || (view.older !== null && start.depth > floor + 1))) {
    const first = entries.findIndex((e) => !e.contextExcluded && placeOf(e) >= start.depth && placeOf(e) > floor)
    if (first < 0) return atLeaf ? { size: entries.length, hidden: -1 } : NONE
    return first > 0 || placeOf(entries[first]!) === start.depth ? { size: first, hidden: -1 } : NONE
  }
  if (budget.nonHistoryTokens + budget.responseReserve > budget.maximum && atLeaf)
    return { size: entries.length, hidden: -1 }
  return NONE
}

/** The hidden line's text: the summary notes sent in the hidden messages' place, by title. */
export const hiddenLineText = (summaryNotes: ReadonlyArray<string> | undefined) => {
  const notes = summaryNotes ?? []
  if (notes.length === 0) return "Messages above this are hidden, so they aren’t sent."
  const names = notes.length === 1 ? notes[0]! : `${notes.slice(0, -1).join(", ")} and ${notes.at(-1)!}`
  return `Messages above this are hidden. ${names} ${notes.length === 1 ? "is" : "are"} sent in their place.`
}
