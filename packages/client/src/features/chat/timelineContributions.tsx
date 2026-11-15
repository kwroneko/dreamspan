import { tokenizerText } from "../editor/tokenCounts.ts"
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { lcmCursor, positionOf } from "./position.ts"
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { LcmState } from "@rp/shared/lcm.ts"
import { makeRegistry } from "../../registry.ts"
import { SlotOutlet } from "../../slots.tsx"
import { ChangeContextSize, contextOrigin, reserveOrigin, targetOrigin, withOrigin } from "./budgetSources.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { MergedChatRow } from "./MergedChatRow.tsx"
import { timelineBoundaries, timelineSummaries } from "./presentation.tsx"
import type { TimelineTransformV1, TimelineInputV1, TimelineRowV1 } from "../../../../plugin-api/src/display.ts"
import { mergeTimeline, historyTimeline, lcmTimeline } from "./timelineParts.ts"
import { Markdown } from "../../ui/Markdown.tsx"
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
  readonly body?: TimelineRowV1["body"]
  readonly render: (context: RenderContext) => ReactNode
}
export interface TimelineContext {
  readonly view: ChatView
  readonly lcm: LcmState | null
  readonly summaries: boolean
  readonly divider: number
  readonly historyDivider: number
}
export interface TimelineTransform {
  readonly id: string
  readonly order: number
  readonly source?: string
  readonly replacement?: string
  readonly asyncTransform?: (
    rows: ReadonlyArray<TimelineRow>,
    context: TimelineContext,
    /** Aborts once the timeline moved on: a call not yet sent to the worker is dropped. */
    abandoned?: AbortSignal
  ) => Promise<ReadonlyArray<TimelineRow>>
  readonly transform: (rows: ReadonlyArray<TimelineRow>, context: TimelineContext) => ReadonlyArray<TimelineRow>
}
export const timelineTransforms = makeRegistry<TimelineTransform>()
export const useTimelineTransforms = () =>
  useSyncExternalStore(timelineTransforms.subscribe, timelineTransforms.snapshot, timelineTransforms.snapshot)

// A transform may read a store of its own (the threads' sets): it says when that changed, and
// the timeline's rows are made again.
let inputs = 0
const inputListeners = new Set<() => void>()
/** What a registered transform reads besides its context changed. */
export const timelineInputsChanged = () => {
  inputs++
  for (const listener of inputListeners) listener()
}
export const useTimelineInputs = () =>
  useSyncExternalStore(
    (listener) => {
      inputListeners.add(listener)
      return () => inputListeners.delete(listener)
    },
    () => inputs
  )
export const messageRows = (entries: ReadonlyArray<PathEntry>): ReadonlyArray<TimelineRow> =>
  entries.map((entry) => ({
    key: entry.slotId,
    estimate: 160,
    from: positionOf(entry),
    to: positionOf(entry),
    entry,
    render: ({ renderMessage }) => renderMessage(entry)
  }))

/** Additional data and host-rendered bodies supplied by another registered feature. */
export const timelineDataSources = makeRegistry<{
  readonly id: string
  readonly source?: string
  readonly threads: (view: ChatView) => TimelineInputV1["threads"]
}>()
export const timelineInput = (rows: ReadonlyArray<TimelineRow>, context: TimelineContext): TimelineInputV1 => {
  if (rows.length > 2000 || context.view.entries.length > 2000) throw new Error("Display copy window is too large")
  return {
    rows: rows.map((row) => ({
      key: row.key,
      estimate: row.estimate,
      from: row.from,
      to: row.to,
      ...(row.lastSlotId === undefined ? {} : { lastSlotId: row.lastSlotId }),
      ...(row.entry
        ? {
            entry: {
              slotId: row.entry.slotId,
              depth: row.entry.depth,
              position: row.entry.position,
              version: row.entry.version ? { origin: row.entry.version.origin } : null
            }
          }
        : {}),
      ...(row.body ? { body: row.body } : {})
    })),
    entries: context.view.entries.map((entry) => ({
      slotId: entry.slotId,
      depth: entry.depth,
      position: entry.position
    })),
    hasBudget: !!context.view.history?.budget,
    assemblyError: !!context.view.history?.assemblyError,
    historyDivider: context.historyDivider,
    divider: context.divider,
    summaries: context.summaries,
    lcm: context.lcm
      ? {
          cursor: lcmCursor(context.lcm),
          layer: context.lcm.layer.map((s) => ({ id: s.id, from: s.from, to: s.to, lastSlotId: s.lastSlotId }))
        }
      : null,
    threads: timelineDataSources.list().flatMap((source) => source.threads(context.view))
  }
}

/** Presentation remains a feature registry, independent of the data-only worker seam. */
export const timelineBodies = makeRegistry<{
  readonly id: string
  readonly source?: string
  readonly row: (
    body: NonNullable<TimelineRowV1["body"]>,
    context: TimelineContext,
    fields: Omit<TimelineRow, "render">
  ) => TimelineRow
}>()

/** Reattach only host-owned renderers to data, never a plugin function or DOM node. */
export const timelineRows = (
  data: ReadonlyArray<TimelineRowV1>,
  rows: ReadonlyArray<TimelineRow>,
  context: TimelineContext,
  trusted = false
): ReadonlyArray<TimelineRow> => {
  if (data === rows) return rows
  const originals = trusted ? undefined : new Map(rows.map((row) => [row.key, row]))
  const entries = trusted ? undefined : new Map(context.view.entries.map((entry) => [entry.slotId as string, entry]))
  return data.map((row): TimelineRow => {
    if (trusted && typeof (row as TimelineRow).render === "function" && row.body?.kind !== "merge")
      return row as TimelineRow
    const original = originals?.get(row.key)
    const entry = row.entry && (entries?.get(row.entry.slotId) ?? (trusted ? (row as TimelineRow).entry : undefined))
    if (!trusted && row.entry && !entry) throw new Error("Unknown message row")
    if (
      !trusted &&
      row.lastSlotId !== undefined &&
      !entries?.has(row.lastSlotId) &&
      !context.lcm?.layer.some((summary) => summary.lastSlotId === row.lastSlotId)
    )
      throw new Error("Unknown row anchor")
    const fields = {
      key: row.key,
      estimate: row.estimate,
      from: row.from,
      to: row.to,
      ...(row.lastSlotId === undefined ? {} : { lastSlotId: row.lastSlotId as SlotId }),
      ...(entry ? { entry } : {}),
      ...(row.body ? { body: row.body } : {})
    }
    if (!row.body) {
      if (!original) throw new Error("Unknown timeline row")
      // A retained row keeps the message, range and anchor it was made with: a copy chooses
      // which rows show, their order and their estimated height, never what a row is about
      // (scrolling to a message and its links follow these fields).
      return trusted ? { ...original, ...fields } : { ...original, estimate: row.estimate }
    }
    const { body } = row

    if (body.kind === "text" && typeof body.text === "string")
      return { ...fields, render: () => <Markdown text={body.text!} streaming={false} /> }
    const renderer = timelineBodies.get(body.kind)
    if (!renderer) throw new Error("Unsupported timeline body")
    return renderer.row(body, context, fields)
  })
}

const builtinTimelineBodies: ReadonlyArray<Parameters<typeof timelineBodies.register>[0]> = [
  {
    id: "merge",
    source: import.meta.url,
    row: (body, context, fields) => {
      const merged = context.view.entries.find((e) => e.slotId === body.ref && e.version?.origin === "merge")
      if (!merged) throw new Error("Unknown merge")
      return { ...fields, render: ({ session }) => <MergedChatRow entry={merged} session={session} /> }
    }
  },
  {
    id: "history",
    source: import.meta.url,
    row: (_body, context, fields) => {
      const budget = context.view.history?.budget
      if (!budget || context.view.history?.assemblyError) throw new Error("Unknown history budget")
      return {
        ...fields,
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
            {budget.countedInput !== undefined && (
              <>
                {" "}
                The next request is about {budget.countedInput.toLocaleString()} tokens.{" "}
                {budget.tokenizer ? tokenizerText(budget.tokenizer) : ""} The history limit is approximate.
              </>
            )}
          </Alert>
        )
      }
    }
  },
  {
    id: "lcm-boundary",
    source: import.meta.url,
    row: (_body, context, fields) => {
      const lcm = context.lcm
      if (!lcm) throw new Error("Unknown summary boundary")
      return {
        ...fields,
        render: ({ onOpenSummaries }) => (
          <SlotOutlet slot={timelineBoundaries} props={{ lcm, onOpen: () => onOpenSummaries(null) }} />
        )
      }
    }
  },
  {
    id: "summary",
    source: import.meta.url,
    row: (body, context, fields) => {
      const summary = context.lcm?.layer.find((s) => s.id === body.ref)
      if (!summary) throw new Error("Unknown summary")
      return {
        ...fields,
        render: ({ session, anchor, renderMessage, onOpenSummaries }) => (
          <SlotOutlet
            slot={timelineSummaries}
            props={{
              session,
              summary,
              renderMessage,
              onOpen: onOpenSummaries,
              target:
                context.view.entries.find(
                  (entry) =>
                    entry.slotId === anchor && positionOf(entry) >= summary.from - 1 && positionOf(entry) < summary.to
                ) ?? null
            }}
          />
        )
      }
    }
  }
]

export const timelinePart = (
  part: Omit<TimelineTransformV1, "transform"> & {
    readonly transform: (input: TimelineInputV1) => ReadonlyArray<TimelineRowV1>
  }
): TimelineTransform => ({
  id: part.id,
  order: part.order,
  ...(part.source ? { source: part.source } : {}),
  transform: (rows, context) => {
    // Originals already own their data/renderers. Avoid walking a long chat merely
    // to project it; only the worker boundary needs detached field projections.
    const input = {
      ...timelineInput([], { ...context, view: { ...context.view, entries: [] } }),
      rows,
      entries: context.view.entries,
      lcm: context.lcm ? { cursor: lcmCursor(context.lcm), layer: context.lcm.layer } : null
    }
    return timelineRows(part.transform(input), rows, context, true)
  }
})
export const registerTimelineTransforms = () => [
  ...builtinTimelineBodies.map((body) => timelineBodies.register(body)),
  ...[mergeTimeline, historyTimeline, lcmTimeline].map((part) => timelineTransforms.register(timelinePart(part)))
]

/** The unchanged synchronous path remains the only path without copies. */
export function useTransformedRows(
  entries: ReadonlyArray<PathEntry>,
  transforms: ReadonlyArray<TimelineTransform>,
  context: TimelineContext,
  inputs: number
) {
  const initial = useMemo(() => messageRows(entries), [entries])
  const ordered = useMemo(() => [...transforms].sort((a, b) => a.order - b.order), [transforms])
  const original = useMemo(
    () => ordered.reduce((rows, entry) => entry.transform(rows, context), initial),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inputs represents registered external data
    [ordered, initial, context, inputs]
  )
  const [answer, setAnswer] = useState<{
    initial: typeof initial
    ordered: typeof ordered
    context: typeof context
    inputs: number
    rows: typeof original
  } | null>(null)
  useEffect(() => {
    if (!ordered.some((entry) => entry.asyncTransform)) return
    // Newest input wins: the timeline changes on every reply, and each change abandons the
    // run before it, so a copy's queue holds one timeline at most.
    const abandoned = new AbortController()
    void (async () => {
      let rows = initial
      for (const entry of ordered) {
        if (abandoned.signal.aborted) return
        rows = await (entry.asyncTransform?.(rows, context, abandoned.signal) ?? entry.transform(rows, context))
      }
      if (!abandoned.signal.aborted) setAnswer({ initial, ordered, context, inputs, rows })
    })()
    return () => abandoned.abort()
  }, [initial, ordered, context, inputs])
  return answer?.initial === initial &&
    answer.ordered === ordered &&
    answer.context === context &&
    answer.inputs === inputs
    ? answer.rows
    : original
}
