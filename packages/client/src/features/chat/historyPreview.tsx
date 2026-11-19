import { isPanelTab, useChatPanels } from "./panels.tsx"
import type { PathEntry } from "@dreamspan/shared/chat.ts"
import type { ChatSession } from "./session.ts"
import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import type { HistoryHit } from "@dreamspan/shared/historyApi.ts"
import type { LcmSummary } from "@dreamspan/shared/lcm.ts"

export const HistoryPreviewContext = createContext<{
  hits: ReadonlyArray<HistoryHit>
  active: boolean
  publish: (hits: ReadonlyArray<HistoryHit>, active?: boolean) => void
}>({ hits: [], active: false, publish: () => undefined })
export function HistoryPreviewProvider({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<{ hits: ReadonlyArray<HistoryHit>; active: boolean }>({
    hits: [],
    active: false
  })
  const publish = useCallback((hits: ReadonlyArray<HistoryHit>, active = true) => setPreview({ hits, active }), [])
  return <HistoryPreviewContext value={{ ...preview, publish }}>{children}</HistoryPreviewContext>
}
export function HistoryDiff({ hit }: { hit: HistoryHit }) {
  let end = 0
  const pieces: ReactNode[] = []
  hit.matches.forEach((match, i) => {
    pieces.push(
      hit.before.slice(end, match.start),
      <mark key={i} className="rounded-sm bg-accent/15 text-text">
        <del className="text-danger">{hit.before.slice(match.start, match.end)}</del>
        <span aria-label="replaced with"> → </span>
        <ins className="text-accent">{match.replacement}</ins>
      </mark>
    )
    end = match.end
  })
  pieces.push(hit.before.slice(end))
  return (
    <div
      aria-label="Replacement preview"
      className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs"
    >
      {pieces}
    </div>
  )
}

export function HistoryMessagePreview({ entry, session }: { entry: PathEntry; session: ChatSession }) {
  const panels = useChatPanels()
  const { hits, active } = useContext(HistoryPreviewContext)
  const preview = hits.find((hit) => hit.kind === "version_replace" && hit.beforeId === entry.version.id)
  if (!active || !preview || !isPanelTab("history", session.snapshot(), panels)) return null
  return (
    <div className="my-2 rounded-md border border-accent/40 p-2">
      <HistoryDiff hit={preview} />
    </div>
  )
}

/** The retained search remains previewable when its result opens the Summaries tab. */
export function HistorySummaryPreview({ summary, session }: { summary: LcmSummary; session: ChatSession }) {
  const panels = useChatPanels()
  const preview = useContext(HistoryPreviewContext).hits.find(
    (hit) => hit.kind === "summary_revision" && hit.targetId === summary.id && hit.beforeId === summary.revisionId
  )
  if (!preview || !isPanelTab("history", session.snapshot(), panels)) return null
  return <HistoryDiff hit={preview} />
}
