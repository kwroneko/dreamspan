// What a summary's edit shows around its text, in the summaries panel and in the summary's own
// tab (textTabs.tsx): the text it's compared with, and how its draft stands.
import type { LcmSummary, SummaryRevision } from "@dreamspan/shared/lcm.ts"
import { useEffect, useState } from "react"
import type { AppError } from "../../errors.ts"
import { Alert } from "../../ui/Surface.tsx"
import { rangeText } from "./lcm.ts"
import type { SummaryDraft, SummaryDraftHost, SummaryDraftSubject, SummaryDraftView } from "./summaryDraft.ts"

type Range = Pick<LcmSummary, "from" | "to">

/** The box's label: "Text of the summary of messages 1–20". */
export const summaryTextLabel = (summary: Range) =>
  `Text of the summary of ${rangeText(summary.from, summary.to).toLowerCase()}`

/** The tab's title after the chat's name: "Summary of messages 1–20". */
export const summaryTabLabel = (summary: Range) => `Summary of ${rangeText(summary.from, summary.to).toLowerCase()}`

/**
 * The saved text the draft is compared with: the revision in use, or the older one the draft
 * started from (read once), null until that's read or when it can't be.
 */
export function useSummaryBase(host: SummaryDraftHost, summary: SummaryDraftSubject, store: SummaryDraft) {
  const baseId = store.comparisonRevisionId
  const [comparison, setComparison] = useState<SummaryRevision | null>(null)
  const [problem, setProblem] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (baseId === summary.revisionId) return
    let live = true
    void host
      .call((client) => client("ListSummaryRevisions", { forkId: host.snapshot().forkId, summaryId: summary.id }))
      .then((result) => {
        if (!live) return
        if (result.ok) {
          const revision = result.value.find((revision) => revision.id === baseId)
          setComparison(revision ?? null)
          setProblem(
            revision
              ? null
              : {
                  tag: "NotFound",
                  message: "The saved text this draft started from is unavailable.",
                  problems: [],
                  reason: null
                }
          )
        } else setProblem(result.error)
      })
    return () => {
      live = false
    }
  }, [host, baseId, summary.id, summary.revisionId, attempt])
  const base =
    baseId === summary.revisionId ? (summary.content ?? "") : comparison?.id === baseId ? comparison.content : null
  return {
    base,
    problem,
    retry: () => {
      setProblem(null)
      setAttempt((attempt) => attempt + 1)
    }
  }
}

/** How the draft stands, under its box. */
export function SummaryDraftStatus({ view, fresh }: { view: SummaryDraftView; fresh: boolean }) {
  return (
    <>
      <p className="text-xs text-muted" aria-live="polite">
        {view.unsaved
          ? view.error
            ? "Not on the server yet: kept in this browser, and sent again when you open this edit."
            : "Keeping your text…"
          : view.changed
            ? "Draft kept. Save to use it."
            : "Unchanged."}
        {fresh ? "" : " Once saved, it stays as you write it, though its messages changed."}
      </p>
      {view.outdated && (
        <Alert tone="warning">
          This draft started from an older text than the one in use. Saving replaces that one.
        </Alert>
      )}
      {view.displaced !== null && (
        <Alert tone="warning">Another tab had typed here too; its text is one step back in the undo history.</Alert>
      )}
      {view.restored > 0 && <Alert>Text typed here earlier and kept in this browser is back in the box.</Alert>}
      {view.recovered > 0 && (
        <Alert>Earlier text from this summary edit is kept in the bin, under Recovered text.</Alert>
      )}
    </>
  )
}
