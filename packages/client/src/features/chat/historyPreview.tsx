import { isPanelTab, useChatPanels } from "./panels.tsx"
import type { PathEntry } from "@rp/shared/chat.ts"
import type { ChatSession } from "./session.ts"
import { createContext, useContext, useState, type ReactNode } from "react"
import type { HistoryHit } from "@rp/shared/historyApi.ts"

export const HistoryPreviewContext = createContext<{
  hits: ReadonlyArray<HistoryHit>
  publish: (hits: ReadonlyArray<HistoryHit>) => void
}>({ hits: [], publish: () => undefined })
export function HistoryPreviewProvider({ children }: { children: ReactNode }) {
  const [hits, publish] = useState<ReadonlyArray<HistoryHit>>([])
  return <HistoryPreviewContext value={{ hits, publish }}>{children}</HistoryPreviewContext>
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
  const preview = useContext(HistoryPreviewContext).hits.find(
    (hit) => hit.kind === "version_replace" && hit.beforeId === entry.version.id
  )
  if (!preview || !isPanelTab("history", session.snapshot(), panels)) return null
  return (
    <div className="my-2 rounded-md border border-accent/40 p-2">
      <HistoryDiff hit={preview} />
    </div>
  )
}
