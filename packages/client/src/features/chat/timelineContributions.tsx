import { useSyncExternalStore, type ReactNode } from "react"
import { lcmCursor, positionOf } from "./position.ts"
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { LcmState } from "@rp/shared/lcm.ts"
import { makeRegistry } from "../../registry.ts"
import { SlotOutlet } from "../../slots.tsx"
import { ChangeContextSize, contextOrigin, reserveOrigin, targetOrigin, withOrigin } from "./budgetSources.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { timelineBoundaries, timelineSummaries } from "./presentation.tsx"
import type { ChatSession, ChatView } from "./session.ts"

interface RenderContext {
  readonly session: ChatSession
  readonly anchor: SlotId | null
  readonly renderMessage: (entry: PathEntry) => ReactNode
  readonly onOpenSummaries: (focus: string | null) => void
}
export interface TimelineRow {
  readonly key: string
  readonly estimate: number
  /** Zero-based inclusive path depths, for positioning links and coverage. */
  readonly from: number
  readonly to: number
  readonly lastSlotId?: SlotId
  readonly entry?: PathEntry
  readonly render: (context: RenderContext) => ReactNode
}
export interface TimelineContext {
  readonly view: ChatView
  readonly lcm: LcmState | null
  readonly summaries: boolean
  readonly divider: number
  readonly historyDivider: number
}
export const timelineTransforms = makeRegistry<{
  readonly id: string
  readonly order: number
  readonly transform: (rows: ReadonlyArray<TimelineRow>, context: TimelineContext) => ReadonlyArray<TimelineRow>
}>()
export const useTimelineTransforms = () =>
  useSyncExternalStore(timelineTransforms.subscribe, timelineTransforms.snapshot, timelineTransforms.snapshot)
export const messageRows = (entries: ReadonlyArray<PathEntry>): ReadonlyArray<TimelineRow> =>
  entries.map((entry) => ({
    key: entry.slotId,
    estimate: 160,
    from: positionOf(entry),
    to: positionOf(entry),
    entry,
    render: ({ renderMessage }) => renderMessage(entry)
  }))

// Earlier transforms may insert rows, clone entries or project a range of messages.
// Resolve a message boundary against the current rows' depth ranges, never its old index.
const boundaryRow = (rows: ReadonlyArray<TimelineRow>, entries: ReadonlyArray<PathEntry>, index: number) => {
  const depth = entries[index] && positionOf(entries[index])
  if (depth === undefined) return rows.length
  const at = rows.findIndex((row) => row.from <= row.to && row.to >= depth)
  return at < 0 ? rows.length : at
}

export const registerTimelineTransforms = () => [
  timelineTransforms.register({
    id: "timeline.history-budget",
    order: 10,
    transform: (rows, { view, historyDivider }) => {
      const budget = view.history?.budget
      if (historyDivider < 0 || !budget) return rows
      const result = [...rows]
      result.splice(boundaryRow(result, view.entries, historyDivider), 0, {
        key: "history-boundary",
        estimate: 64,
        from: Infinity,
        to: -1,
        render: () => (
          <Alert
            tone={budget.origins?.context === "assumed" ? "warning" : "neutral"}
            actions={<ChangeContextSize origins={budget.origins} />}
          >
            Messages above this aren&rsquo;t sent to the model: the model’s context budget allows{" "}
            {withOrigin(budget.maximum, contextOrigin(budget.origins), " tokens")}, targets{" "}
            {withOrigin(budget.target, targetOrigin(budget.origins))}, reserves{" "}
            {withOrigin(budget.responseReserve, reserveOrigin(budget.origins))} for the reply, and the card, prompts and
            other fixed content take ~{budget.nonHistoryTokens.toLocaleString()}.
          </Alert>
        )
      })
      return result
    }
  }),
  timelineTransforms.register({
    id: "timeline.lcm",
    order: 20,
    transform: (rows, { view, lcm, summaries, divider, historyDivider }) => {
      const entries = view.entries
      const original = [...rows]
      if (divider >= 0 && lcm) {
        let at = boundaryRow(original, entries, divider)
        if (divider === historyDivider && original[at - 1]?.key === "history-boundary") at--
        original.splice(at, 0, {
          key: "lcm-boundary",
          estimate: 44,
          from: lcmCursor(lcm) + 1,
          to: -1,
          render: ({ onOpenSummaries }) => (
            <SlotOutlet slot={timelineBoundaries} props={{ lcm, onOpen: () => onOpenSummaries(null) }} />
          )
        })
      }
      const layer = summaries
        ? (lcm?.layer ?? []).filter((s) => s.from <= (entries.at(-1) ? positionOf(entries.at(-1)!) : -1) + 1)
        : []
      const result: TimelineRow[] = []
      let next = 0
      const append = () => {
        const summary = layer[next++]!
        result.push({
          key: summary.id,
          estimate: 64,
          from: summary.from - 1,
          to: summary.to - 1,
          lastSlotId: summary.lastSlotId,
          render: ({ session, anchor, renderMessage }) => (
            <SlotOutlet
              slot={timelineSummaries}
              props={{
                session,
                summary,
                renderMessage,
                target:
                  entries.find(
                    (entry) =>
                      entry.slotId === anchor && positionOf(entry) >= summary.from - 1 && positionOf(entry) < summary.to
                  ) ?? null
              }}
            />
          )
        })
      }
      for (const row of original) {
        while (next < layer.length && layer[next]!.from - 1 <= row.from) append()
        if (!row.entry || !layer.some((s) => positionOf(row.entry!) >= s.from - 1 && positionOf(row.entry!) < s.to))
          result.push(row)
      }
      while (next < layer.length) append()
      return result
    }
  })
]
