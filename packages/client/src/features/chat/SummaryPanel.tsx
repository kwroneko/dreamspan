import { SlotOutlet } from "../../slots.tsx"
import { summaryEditorTools, summaryTextEditor } from "./editorHistory.tsx"
// The summaries in use on the path shown (DESIGN §8.1, ARCHITECTURE §16): by level and
// range, each with its state and what can be done to it. Nothing here generates: asking for
// a summary to be made again is a request the planner finds with the next reply.
import { useSyncExternalStore, useEffect, useMemo, useRef, useState } from "react"
import type { SlotId } from "@rp/shared/chat.ts"
import type { LcmBackfill, LcmJob, LcmState, LcmSummary, SummaryRevision } from "@rp/shared/lcm.ts"
import type { AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { RevisionComparison } from "../../ui/RevisionDiff.tsx"
import { Alert, Badge } from "../../ui/Surface.tsx"
import { EstimateList } from "./EnableLcmDialog.tsx"
import { boundaryText, countText, healthOf, jobText, moneyText, originText, rangeText, tokensText } from "./lcm.ts"
import type { ChatSession } from "./session.ts"
import { TimelineToggle } from "./TimelineToggle.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { SummaryDraft } from "./summaryDraft.ts"

function Problem({ error }: { error: AppError | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null
}

function StateBadges({ summary }: { summary: LcmSummary }) {
  const health = healthOf(summary)
  return (
    <>
      {health === "stale" && <Badge tone="warning">Stale</Badge>}
      {health === "failed" && <Badge tone="danger">Failed</Badge>}
      {health === "resolved" && <Badge>Resolved failure</Badge>}
      {summary.origin === "user" && <Badge>Edited</Badge>}
      {summary.origin === "imported" && <Badge>Imported from SillyTavern</Badge>}
      {summary.status === "truncated" && <Badge>Cut short</Badge>}
      {summary.replacementAvailable && <Badge>Replacement available in Revisions</Badge>}
      {summary.rerun && <Badge tone="accent">Re-summarizes with the next reply</Badge>}
    </>
  )
}

/** The text of a summary being edited, saved as a draft while typing and as a revision on Save. */
function Editor({ session, summary, onDone }: { session: ChatSession; summary: LcmSummary; onDone: () => void }) {
  const userId = useSession().user.id
  const [store] = useState(() => new SummaryDraft(session, userId, summary))
  const view = useSyncExternalStore(store.subscribe, store.snapshot)
  useEffect(() => {
    void store.open()
    return () => store.dispose()
  }, [store])
  useEffect(() => store.update(summary), [store, summary])
  const baseId = store.comparisonRevisionId
  const [comparison, setComparison] = useState<SummaryRevision | null>(null)
  const [comparisonError, setComparisonError] = useState<AppError | null>(null)
  useEffect(() => {
    if (baseId === summary.revisionId) return
    let live = true
    void session
      .call((client) =>
        client("ListSummaryRevisions", {
          forkId: session.snapshot().forkId,
          summaryId: summary.id
        })
      )
      .then((result) => {
        if (!live) return
        if (result.ok) setComparison(result.value.find((revision) => revision.id === baseId) ?? null)
        else setComparisonError(result.error)
      })
    return () => {
      live = false
    }
  }, [session, baseId, summary.id, summary.revisionId])
  const base =
    baseId === summary.revisionId ? (summary.content ?? "") : comparison?.id === baseId ? comparison.content : null
  const [pending, setPending] = useState(false)
  const finish = async (action: () => Promise<{ ok: boolean }>) => {
    setPending(true)
    const outcome = await action()
    setPending(false)
    if (outcome.ok) onDone()
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        // Text typed while the revision was being saved keeps the edit open.
        void finish(async () => {
          const outcome = await store.commit()
          return { ok: outcome.ok && outcome.value.done }
        })
      }}
    >
      <SlotOutlet
        slot={summaryTextEditor}
        props={{
          label: `Text of the summary of ${rangeText(summary.from, summary.to).toLowerCase()}`,
          value: view.text,
          base: base ?? "",
          readOnly: view.loading || base === null,
          onChange: (value) => store.setText(value)
        }}
      />
      <p className="text-xs text-muted" aria-live="polite">
        {view.unsaved
          ? view.error
            ? "Not on the server yet: kept in this browser, and sent again when you open this edit."
            : "Keeping your text…"
          : view.changed
            ? "Your text is kept as a draft."
            : "Unchanged."}
        {summary.fresh ? "" : " It stays as you write it even though the messages changed."}
      </p>
      {view.outdated && (
        <Alert tone="warning">The draft started from an older revision than the one in use. Saving replaces it.</Alert>
      )}
      {view.displaced !== null && (
        <Alert tone="warning">Another tab had typed here too; its text is one step back in the undo history.</Alert>
      )}
      {view.restored > 0 && <Alert>Text typed here earlier and kept in this browser is back in the box.</Alert>}
      {view.recovered > 0 && <Alert>Earlier text from this edit is in the bin's recovered texts.</Alert>}
      {base !== null && <SlotOutlet slot={summaryEditorTools} props={{ draft: store, base }} />}
      <Problem error={comparisonError} />
      <Problem error={view.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={pending} disabled={!view.changed || view.text.trim() === ""}>
          Save revision
        </Button>
        <Button onClick={() => void store.undo()} disabled={view.loading}>
          Undo
        </Button>
        <Button onClick={() => void finish(() => store.discard())} pending={pending} aria-label="Cancel the edit">
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Revisions({ session, summary }: { session: ChatSession; summary: LcmSummary }) {
  const [revisions, setRevisions] = useState<ReadonlyArray<SummaryRevision> | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  useEffect(() => {
    let live = true
    void session
      .call((client) => client("ListSummaryRevisions", { forkId: session.snapshot().forkId, summaryId: summary.id }))
      .then((result) => {
        if (!live) return
        if (result.ok) setRevisions(result.value)
        else setError(result.error)
      })
    return () => {
      live = false
    }
  }, [session, summary.id, summary.rowVersion])
  const use = async (revision: SummaryRevision) => {
    const result = await session.call((client) =>
      client("SelectSummaryRevision", {
        forkId: session.snapshot().forkId,
        summaryId: summary.id,
        revisionId: revision.id,
        expectedRowVersion: summary.rowVersion
      })
    )
    setError(result.ok ? null : result.error)
  }
  if (revisions === null)
    return error ? <Problem error={error} /> : <p className="text-sm text-muted">Loading the revisions…</p>
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Revisions" className="flex flex-col divide-y divide-border rounded-md border border-border">
        {revisions.map((revision) => (
          <li key={revision.id} className="flex flex-col gap-1 p-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Revision {revision.number}</span>
              <span className="text-muted">
                {originText(revision.origin)}, {tokensText(revision.tokens)}
              </span>
              {revision.selected ? (
                <Badge tone="accent">In use</Badge>
              ) : (
                <Button
                  variant="ghost"
                  aria-label={`Use revision ${revision.number}`}
                  onClick={() => void use(revision)}
                >
                  Use this one
                </Button>
              )}
            </div>
            <RevisionComparison
              label={`Compare revision ${revision.number} with saved text`}
              before={revision.content}
              after={summary.content ?? ""}
            />
          </li>
        ))}
      </ol>
      <Problem error={error} />
    </div>
  )
}

/** The summaries one condenses, a level down. */
function Children({
  session,
  summary,
  onJump
}: {
  session: ChatSession
  summary: LcmSummary
  onJump: (slot: SlotId) => void
}) {
  const [rows, setRows] = useState<ReadonlyArray<LcmSummary> | null>(null)
  useEffect(() => {
    let live = true
    void session.coverage(summary.from - 1, summary.to - 1).then((coverage) => {
      if (live && coverage) setRows(coverage.summaries.filter((s) => summary.children.includes(s.id)))
    })
    return () => {
      live = false
    }
  }, [session, summary])
  if (rows === null) return <p className="text-sm text-muted">Loading…</p>
  return (
    <ul aria-label={`Summaries condensed into level ${summary.level}`} className="flex flex-col gap-1 pl-3">
      {rows.map((child) => (
        <li key={child.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge>Level {child.level}</Badge>
          <button
            type="button"
            className="text-accent underline-offset-2 hover:underline"
            onClick={() => onJump(child.firstSlotId)}
          >
            {rangeText(child.from, child.to)}
          </button>
          <StateBadges summary={child} />
        </li>
      ))}
    </ul>
  )
}

type Mode = "view" | "edit" | "revisions" | "children"

function SummaryRow({
  session,
  summary,
  focused,
  blockedByManual = false,
  onJump
}: {
  session: ChatSession
  summary: LcmSummary
  focused: boolean
  blockedByManual?: boolean
  onJump: (slot: SlotId) => void
}) {
  const [mode, setMode] = useState<Mode>("view")
  const [error, setError] = useState<AppError | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" })
  }, [focused])
  // Coverage rows come without text: read it when a row is shown.
  const content = summary.content ?? loaded
  useEffect(() => {
    if (summary.content !== null) return
    let live = true
    void session
      .call((client) => client("GetSummary", { forkId: session.snapshot().forkId, summaryId: summary.id }))
      .then((result) => {
        if (live && result.ok) setLoaded(result.value.content)
      })
    return () => {
      live = false
    }
  }, [session, summary.id, summary.content])
  const health = healthOf(summary)
  const rerun = async (requested: boolean) => {
    const result = await session.call((client) =>
      client("SetSummaryRerun", {
        forkId: session.snapshot().forkId,
        chatId: session.id,
        target: { _tag: "Summary", summaryId: summary.id },
        requested
      })
    )
    setError(result.ok ? null : result.error)
  }
  return (
    <li
      ref={ref}
      data-summary={summary.id}
      data-level={summary.level}
      data-health={health}
      className={`flex flex-col gap-2 py-3 first:pt-0 last:pb-0 ${focused ? "rounded-md ring-2 ring-accent/60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="accent">Level {summary.level}</Badge>
        <button
          type="button"
          className="font-medium text-accent underline-offset-2 hover:underline"
          aria-label={`${rangeText(summary.from, summary.to)}: show the first message`}
          onClick={() => onJump(summary.firstSlotId)}
        >
          {rangeText(summary.from, summary.to)}
        </button>
        <span className="text-muted">{tokensText(summary.tokens)}</span>
        <StateBadges summary={summary} />
      </div>
      {summary.error && <p className="text-sm text-danger">{summary.error}</p>}
      {blockedByManual && (
        <p className="text-sm text-muted">
          Edit or re-summarize the covering summary to change this part of the context.
        </p>
      )}
      {mode === "edit" ? (
        <Editor
          key={session.snapshot().forkId}
          session={session}
          summary={{ ...summary, content }}
          onDone={() => setMode("view")}
        />
      ) : (
        content !== null &&
        content !== "" && (
          <p className="max-h-48 overflow-y-auto text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{content}</p>
        )
      )}
      {mode !== "edit" && (
        <div className="flex flex-wrap gap-1">
          {summary.status !== "failed" && (
            <Button
              variant="ghost"
              aria-label={`Edit the summary of ${rangeText(summary.from, summary.to).toLowerCase()}`}
              onClick={() => setMode("edit")}
            >
              Edit
            </Button>
          )}
          {summary.revisionCount > 1 && (
            <Button
              variant="ghost"
              aria-expanded={mode === "revisions"}
              aria-label={`Revisions of the summary of ${rangeText(summary.from, summary.to).toLowerCase()}`}
              onClick={() => setMode(mode === "revisions" ? "view" : "revisions")}
            >
              Revisions ({summary.revisionCount})
            </Button>
          )}
          {summary.level > 1 && (
            <Button
              variant="ghost"
              aria-expanded={mode === "children"}
              onClick={() => setMode(mode === "children" ? "view" : "children")}
            >
              Condensed from {summary.children.length}
            </Button>
          )}
          <Button
            variant="ghost"
            aria-pressed={summary.rerun}
            disabled={blockedByManual && !summary.rerun}
            aria-label={`${summary.rerun ? "Cancel re-summarizing" : "Re-summarize"} ${rangeText(summary.from, summary.to).toLowerCase()} with the next reply`}
            onClick={() => void rerun(!summary.rerun)}
          >
            {summary.rerun ? "Cancel re-summarize" : health === "failed" ? "Retry" : "Re-summarize"}
          </Button>
        </div>
      )}
      {mode === "revisions" && <Revisions session={session} summary={summary} />}
      {mode === "children" && <Children session={session} summary={summary} onJump={onJump} />}
      <Problem error={error} />
    </li>
  )
}

function JobRow({ session, job, onJump }: { session: ChatSession; job: LcmJob; onJump: (slot: SlotId) => void }) {
  const [error, setError] = useState<AppError | null>(null)
  const ask = async (requested: boolean) => {
    const result = await session.call((client) =>
      client("SetSummaryRerun", {
        forkId: session.snapshot().forkId,
        chatId: session.id,
        target: { _tag: "Job", jobId: job.id },
        requested
      })
    )
    setError(result.ok ? null : result.error)
  }
  return (
    <li data-job={job.id} data-status={job.status} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={job.status === "failed" ? "danger" : "accent"}>
          {job.status === "failed" ? "Failed" : job.status === "processing" ? "Running" : "Queued"}
        </Badge>
        <button
          type="button"
          className="text-accent underline-offset-2 hover:underline"
          aria-label={`${rangeText(job.from, job.to)}: show the first message`}
          onClick={() => onJump(job.firstSlotId)}
        >
          {jobText(job)}
        </button>
        {job.rerun && <Badge tone="accent">Retries with the next reply</Badge>}
      </div>
      {job.error && <p className="text-sm break-words text-danger">{job.error}</p>}
      {job.status === "failed" && (
        <div>
          <Button
            variant="ghost"
            aria-pressed={job.rerun}
            aria-label={`${job.rerun ? "Cancel the retry of" : "Retry"} ${rangeText(job.from, job.to).toLowerCase()} with the next reply`}
            onClick={() => void ask(!job.rerun)}
          >
            {job.rerun ? "Cancel retry" : "Retry"}
          </Button>
        </div>
      )}
      <Problem error={error} />
    </li>
  )
}

const backfillStates: Record<LcmBackfill["state"], string> = {
  waiting: "Starts with your next reply, or now",
  running: "In progress",
  paused: "Paused",
  capped: "Stopped at the spending limit",
  done: "Done"
}

/**
 * The backfill of a chat that summaries were enabled on (spec/LCM.md §2.11): what is left and
 * what it costs, what has been spent against the limit, and the buttons. Summarize now is the
 * one click here that starts work.
 */
function Backfill({ session, lcm }: { session: ChatSession; lcm: LcmState }) {
  const [backfill, setBackfill] = useState<LcmBackfill | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  // Read again whenever the summaries were read: a job started, finished or was queued, or the backfill ended.
  useEffect(() => {
    let live = true
    let read = 0
    const load = () => {
      const mine = ++read
      void session
        .call((client) =>
          client("GetLcmBackfill", {
            forkId: session.snapshot().forkId,
            chatId: session.id,
            leafSlotId: lcm.leafSlotId
          })
        )
        .then((result) => {
          if (!live || mine < read) return
          if (result.ok) setBackfill(result.value)
          else setError(result.error)
        })
    }
    load()
    const off = session.onLcmRead(load)
    return () => {
      live = false
      off()
    }
  }, [session, lcm.leafSlotId])
  const act = async (action: "pause" | "continue" | "summarizeNow") => {
    setPending(action)
    const result = await session.call((client) =>
      client("SetLcmBackfill", {
        forkId: session.snapshot().forkId,
        chatId: session.id,
        leafSlotId: lcm.leafSlotId,
        action,
        ...(action === "continue" && backfill ? { approved: backfill.remaining } : {})
      })
    )
    setPending(null)
    if (result.ok) {
      setBackfill(result.value)
      setError(null)
    } else {
      setError(result.error)
      if (result.error.tag === "LcmEstimateChanged") {
        const updated = await session.call((client) =>
          client("GetLcmBackfill", {
            forkId: session.snapshot().forkId,
            chatId: session.id,
            leafSlotId: lcm.leafSlotId
          })
        )
        if (updated.ok) setBackfill(updated.value)
      }
    }
  }
  if (backfill === null || backfill.state === "done") return <Problem error={error} />
  const jobs = backfill.remaining.l1Jobs + backfill.remaining.condensations
  return (
    <section aria-label="Backfill" data-testid="backfill" data-state={backfill.state} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Older messages</span>
        <Badge tone={backfill.state === "capped" ? "warning" : "accent"}>{backfillStates[backfill.state]}</Badge>
      </div>
      {jobs > 0 && <EstimateList estimate={backfill.remaining} title="What is left" />}
      <p className="text-sm text-muted" data-testid="backfill-spent">
        Spent so far: {countText(backfill.spentTokens)} tokens
        {backfill.spentCost !== null && backfill.currency
          ? ` (${moneyText(backfill.spentCost, backfill.currency)})`
          : ""}
        , of up to {countText(backfill.capTokens)}
        {backfill.capCost !== null && backfill.currency ? ` (${moneyText(backfill.capCost, backfill.currency)})` : ""}.
      </p>
      {backfill.state === "capped" && (
        <Alert tone="warning">
          Spending reached the limit, 150% of the estimate. Nothing more starts until you continue; the limit then
          becomes 150% of what is left.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {(backfill.state === "paused" || backfill.state === "capped") && (
          <Button variant="primary" pending={pending === "continue"} onClick={() => void act("continue")}>
            Continue
          </Button>
        )}
        {(backfill.state === "waiting" || backfill.state === "running") && (
          <Button variant="primary" pending={pending === "summarizeNow"} onClick={() => void act("summarizeNow")}>
            Summarize now
          </Button>
        )}
        {backfill.state === "running" && (
          <Button pending={pending === "pause"} onClick={() => void act("pause")}>
            Pause
          </Button>
        )}
      </div>
      <Problem error={error} />
    </section>
  )
}

/** The side panel's Summaries tab: the summaries on this branch, opened from the divider, the rail or the header. */
export function SummaryPanel({
  session,
  lcm,
  focus,
  onJump,
  onEnable
}: {
  session: ChatSession
  lcm: LcmState
  /** A summary to show even when it isn't in use (a click on the rail). */
  focus: string | null
  onJump: (slot: SlotId) => void
  /** Turns summaries on for the chat, asking first what it costs. */
  onEnable: () => void
}) {
  const viewer = useViewPrefs()
  const inUse = useMemo(() => new Set<string>(lcm.layer.map((s) => s.id)), [lcm.layer])
  const version = useSyncExternalStore(session.subscribe, session.snapshot).lcmVersion
  const [fetched, setFetched] = useState<LcmSummary | null>(null)
  const known = focus === null ? undefined : lcm.failed.find((s) => s.id === focus)
  const wanted = focus !== null && !inUse.has(focus) && known === undefined ? focus : null
  useEffect(() => {
    if (wanted === null) return
    let live = true
    void session
      .call((client) =>
        client("GetSummary", { forkId: session.snapshot().forkId, summaryId: wanted as LcmSummary["id"] })
      )
      .then(async (result) => {
        if (!live || !result.ok) return
        const s = result.value
        const coverage = await session.coverage(s.from - 1, s.to - 1, true)
        if (!live) return
        const row = coverage?.summaries.find((row) => row.id === s.id)
        if (row) setFetched({ ...row, content: s.content })
      })
    return () => {
      live = false
    }
  }, [session, wanted, version])
  const blockedByManual = (s: LcmSummary) =>
    lcm.layer.some(
      (parent) => parent.id !== s.id && parent.origin !== "generated" && parent.from <= s.from && parent.to >= s.to
    )
  const extra = wanted !== null && fetched?.id === wanted ? fetched : null
  const unfinished = lcm.jobs.filter(
    (job) =>
      job.status !== "failed" ||
      !lcm.failed.some((s) => s.level === job.level && s.from === job.from && s.to === job.to)
  )
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        What stands in for older messages on this branch. Nothing here runs until your next reply, except Summarize now.
      </p>
      <p className="text-sm font-medium" data-testid="summary-panel-heading">
        {boundaryText(lcm)}
      </p>
      <TimelineToggle />
      {viewer.error && <Problem error={viewer.error} />}
      {lcm.enabled ? (
        <Switch
          checked={viewer.prefs.coverageRail}
          disabled={!viewer.ready || viewer.pending}
          onCheckedChange={(coverageRail) => void viewer.change({ coverageRail })}
          description="Bars beside the messages showing which summary covers them. Saved for your account."
        >
          Coverage rail
        </Switch>
      ) : (
        <Alert
          tone="warning"
          actions={
            <Button variant="primary" onClick={onEnable}>
              Enable summaries
            </Button>
          }
        >
          Summaries are off for this chat.
        </Alert>
      )}
      {lcm.enabled && <Backfill session={session} lcm={lcm} />}
      {unfinished.length > 0 && (
        <ul aria-label="Work in progress" className="flex flex-col divide-y divide-border">
          {unfinished.map((job) => (
            <JobRow key={job.id} session={session} job={job} onJump={onJump} />
          ))}
        </ul>
      )}
      {lcm.failed.length > 0 && (
        <ul aria-label="Failed summaries" className="flex flex-col divide-y divide-border">
          {lcm.failed.map((summary) => (
            <SummaryRow
              key={`${session.snapshot().forkId}:${summary.id}`}
              session={session}
              summary={summary}
              focused={summary.id === focus}
              blockedByManual={blockedByManual(summary)}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
      {lcm.layer.length > 0 ? (
        <ul aria-label="Summaries in use" className="flex flex-col divide-y divide-border">
          {lcm.layer.map((summary) => (
            <SummaryRow
              key={`${session.snapshot().forkId}:${summary.id}`}
              session={session}
              summary={summary}
              focused={summary.id === focus}
              blockedByManual={blockedByManual(summary)}
              onJump={onJump}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          Nothing is summarized yet. Summaries appear as the chat outgrows what the model is sent.
        </p>
      )}
      {extra !== null && (
        <section aria-label="Not in use" className="flex flex-col gap-2">
          <p className="text-sm text-muted">This summary is condensed into one above, so it isn't sent itself.</p>
          <ul className="flex flex-col">
            <SummaryRow
              session={session}
              summary={extra}
              focused
              blockedByManual={blockedByManual(extra)}
              onJump={onJump}
            />
          </ul>
        </section>
      )}
    </div>
  )
}
