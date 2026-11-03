import { usePlaceParam } from "../../usePlaceParam.ts"
import { showToast } from "../../ui/Toast.tsx"
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
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { RevisionComparison } from "../../ui/RevisionDiff.tsx"
import { Alert, Disclosure } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { EstimateList } from "./EnableLcmDialog.tsx"
import { boundaryText, countText, failureText, healthOf, moneyText, originText, rangeText, tokensText } from "./lcm.ts"
import { ClampedText, HintBadge, LevelBadge, SummaryBadges } from "./summaryParts.tsx"
import type { ChatSession } from "./session.ts"
import { TimelineToggle } from "./TimelineToggle.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { SummaryDraft } from "./summaryDraft.ts"
import { summaryPreviews } from "./presentation.tsx"

function Problem({ error }: { error: AppError | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null
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
  const [comparisonAttempt, setComparisonAttempt] = useState(0)
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
        if (result.ok) {
          const revision = result.value.find((revision) => revision.id === baseId)
          setComparison(revision ?? null)
          setComparisonError(
            revision
              ? null
              : {
                  tag: "NotFound",
                  message: "The saved text this draft started from is unavailable.",
                  problems: [],
                  reason: null
                }
          )
        } else setComparisonError(result.error)
      })
    return () => {
      live = false
    }
  }, [session, baseId, summary.id, summary.revisionId, comparisonAttempt])
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
            ? "Draft kept. Save to use it."
            : "Unchanged."}
        {summary.fresh ? "" : " Once saved, it stays as you write it, though its messages changed."}
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
      {base !== null && <SlotOutlet slot={summaryEditorTools} props={{ draft: store, base }} />}
      {base === null && comparisonError && (
        <>
          <Problem error={comparisonError} />
          <Button
            onClick={() => {
              setComparisonError(null)
              setComparisonAttempt((attempt) => attempt + 1)
            }}
          >
            Retry saved text
          </Button>
        </>
      )}
      <Problem error={view.error} />
      <div className="flex flex-wrap gap-2">
        <Tooltip label="Uses this text for the summary from now on, as a new revision.">
          <Button type="submit" variant="primary" pending={pending} disabled={!view.changed || view.text.trim() === ""}>
            Save
          </Button>
        </Tooltip>
        <Tooltip label="Takes back the last change to the text.">
          <Button onClick={() => void store.undo()} disabled={view.loading}>
            Undo
          </Button>
        </Tooltip>
        <Tooltip label="Closes this without saving. What you typed is kept in the bin, under Recovered text.">
          <Button
            onClick={() => void finish(() => store.discard())}
            pending={pending}
            aria-label="Discard the summary edit"
          >
            Discard
          </Button>
        </Tooltip>
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">Revision {revision.number}</span>
              <span className="text-xs text-muted">
                {originText(revision.origin)}, {tokensText(revision.tokens)}
              </span>
              <span className="ml-auto">
                {revision.selected ? (
                  <HintBadge tone="accent" hint="The text the model is sent for these messages.">
                    In use
                  </HintBadge>
                ) : (
                  <Tooltip label="Makes this text the summary again. The one in use stays among the revisions.">
                    <Button
                      variant="ghost"
                      className="h-7 px-2"
                      aria-label={`Use revision ${revision.number}`}
                      onClick={() => void use(revision)}
                    >
                      Use
                    </Button>
                  </Tooltip>
                )}
              </span>
            </div>
            {!revision.selected && (
              <RevisionComparison
                label={`Compare revision ${revision.number} with the text in use`}
                before={revision.content}
                after={summary.content ?? ""}
              />
            )}
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
    <ul
      aria-label={`Summaries condensed into level ${summary.level}`}
      className="flex flex-col gap-1 border-l-2 border-border pl-3"
    >
      {rows.map((child) => (
        <li key={child.id} className="flex flex-wrap items-center gap-2 text-sm">
          <LevelBadge level={child.level} />
          <Tooltip label="Shows its first message in the chat.">
            <button
              type="button"
              className="rounded-sm text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              onClick={() => onJump(child.firstSlotId)}
            >
              {rangeText(child.from, child.to)}
            </button>
          </Tooltip>
          <SummaryBadges summary={child} />
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
  const [mode, setMode] = usePlaceParam<Mode>(`summaryMode:${summary.id}`, "view", [
    "view",
    "edit",
    "revisions",
    "children"
  ])
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
  const range = rangeText(summary.from, summary.to)
  const failed = health === "failed"
  const retryBlocked = blockedByManual && !summary.rerun
  return (
    <li
      ref={ref}
      data-summary={summary.id}
      data-level={summary.level}
      data-health={health}
      className={`flex flex-col gap-2 rounded-md border bg-surface px-3 py-2 ${
        focused ? "border-accent ring-2 ring-accent/40" : failed ? "border-danger/40" : "border-border"
      }`}
    >
      <div className="flex items-start gap-1">
        <div className="my-1 flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <LevelBadge level={summary.level} />
          <Tooltip label="Shows its first message in the chat.">
            <button
              type="button"
              className="rounded-sm font-medium text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              aria-label={`${range}: show the first message`}
              onClick={() => onJump(summary.firstSlotId)}
            >
              {range}
            </button>
          </Tooltip>
          {!failed && <span className="text-xs text-muted">{tokensText(summary.tokens)}</span>}
          <SummaryBadges summary={summary} />
        </div>
        <div className="flex shrink-0 items-center">
          {failed ? (
            <Tooltip
              label={
                retryBlocked
                  ? "Your own summary of these messages is used instead, so trying again changes nothing. Re-summarize that one to replace it."
                  : summary.rerun
                    ? "Leaves it failed: it isn't tried again."
                    : "Tries it again with your next reply."
              }
            >
              <Button
                variant="ghost"
                className="h-8 px-2"
                aria-pressed={summary.rerun}
                disabled={retryBlocked}
                focusableWhenDisabled
                aria-label={`${summary.rerun ? "Cancel re-summarizing" : "Re-summarize"} ${range.toLowerCase()} with the next reply`}
                onClick={() => void rerun(!summary.rerun)}
              >
                {summary.rerun ? "Cancel retry" : "Retry"}
              </Button>
            </Tooltip>
          ) : (
            <IconButton
              icon="edit"
              label={`Edit the summary of ${range.toLowerCase()}`}
              hint={mode === "edit" ? "This summary is already open for editing." : "Edit the text"}
              disabled={mode === "edit"}
              focusableWhenDisabled
              onClick={() => setMode("edit")}
            />
          )}
          <SlotOutlet slot={summaryPreviews} props={{ summary, session }} />
          {!failed && (
            <Menu
              label={`Actions for the summary of ${range.toLowerCase()}`}
              trigger={
                <Button
                  variant="ghost"
                  className="size-8 shrink-0 px-0!"
                  aria-label={`Actions for the summary of ${range.toLowerCase()}`}
                  disabled={mode === "edit"}
                  focusableWhenDisabled
                  hint={
                    mode === "edit"
                      ? "Finish editing this summary to use its other actions."
                      : "Revisions and re-summarizing for this summary."
                  }
                >
                  <Icon name="more" />
                </Button>
              }
            >
              {summary.revisionCount > 1 && (
                <MenuItem
                  icon="history"
                  description="Its earlier texts, to compare or use instead."
                  aria-label={`Revisions of the summary of ${range.toLowerCase()}`}
                  onClick={() => setMode(mode === "revisions" ? "view" : "revisions")}
                >
                  {mode === "revisions" ? "Hide revisions" : `Revisions (${summary.revisionCount})`}
                </MenuItem>
              )}
              {summary.level > 1 && (
                <MenuItem
                  icon="layers"
                  description="The summaries a level down that this one condenses."
                  onClick={() => setMode(mode === "children" ? "view" : "children")}
                >
                  {mode === "children" ? "Hide its parts" : `Condensed from ${summary.children.length}`}
                </MenuItem>
              )}
              <MenuItem
                icon="regenerate"
                disabled={retryBlocked}
                description={
                  retryBlocked
                    ? "Your own summary over these messages is used instead. Re-summarize that one."
                    : summary.rerun
                      ? "Keeps it as it is: it isn't written again."
                      : summary.origin === "generated"
                        ? "Writes it again from its messages with your next reply."
                        : "Writes it again with your next reply. Your text stays in use; the new one waits in Revisions."
                }
                aria-label={`${summary.rerun ? "Cancel re-summarizing" : "Re-summarize"} ${range.toLowerCase()} with the next reply`}
                onClick={() => void rerun(!summary.rerun)}
              >
                {summary.rerun ? "Cancel re-summarize" : "Re-summarize"}
              </MenuItem>
            </Menu>
          )}
        </div>
      </div>
      {summary.error && failed && <p className="text-sm text-danger">{failureText(summary.error)}</p>}
      {blockedByManual && (
        <p className="text-xs text-muted">
          Your own summary over these messages is used instead, so this one isn&apos;t sent.
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
        content !== null && content !== "" && <ClampedText text={content} />
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
  const range = rangeText(job.from, job.to)
  const status =
    job.status === "failed"
      ? {
          label: "Failed",
          tone: "danger" as const,
          hint: "Given up on after its retries. Its messages are sent as they are while they fit."
        }
      : job.status === "processing"
        ? { label: "Writing", tone: "accent" as const, hint: "Being written now." }
        : { label: "Queued", tone: "accent" as const, hint: "Waiting its turn: written after the ones before it." }
  return (
    <li
      data-job={job.id}
      data-status={job.status}
      className={`flex flex-col gap-1 rounded-md border bg-surface px-3 py-2 ${job.status === "failed" ? "border-danger/40" : "border-border"}`}
    >
      <div className="flex items-start gap-1">
        <div className="my-1 flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <LevelBadge level={job.level} />
          <Tooltip label="Shows its first message in the chat.">
            <button
              type="button"
              className="rounded-sm text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              aria-label={`${range}: show the first message`}
              onClick={() => onJump(job.firstSlotId)}
            >
              {range}
            </button>
          </Tooltip>
          <HintBadge tone={status.tone} hint={status.hint}>
            {status.label}
          </HintBadge>
          {job.rerun && (
            <HintBadge tone="accent" hint="You asked for it to be tried again. That happens with your next reply.">
              Retry next reply
            </HintBadge>
          )}
        </div>
        {job.status === "failed" && (
          <Tooltip
            label={job.rerun ? "Leaves it failed: it isn't tried again." : "Tries it again with your next reply."}
          >
            <Button
              variant="ghost"
              className="h-8 shrink-0 px-2"
              aria-pressed={job.rerun}
              aria-label={`${job.rerun ? "Cancel the retry of" : "Retry"} ${range.toLowerCase()} with the next reply`}
              onClick={() => void ask(!job.rerun)}
            >
              {job.rerun ? "Cancel retry" : "Retry"}
            </Button>
          </Tooltip>
        )}
      </div>
      {job.error && <p className="text-sm break-words text-danger">{failureText(job.error)}</p>}
      <Problem error={error} />
    </li>
  )
}

const backfillStates: Record<LcmBackfill["state"], { label: string; hint: string }> = {
  waiting: { label: "Not started", hint: "Starts with your next reply, or now with Summarize now." },
  running: { label: "In progress", hint: "The older messages are being summarized." },
  paused: { label: "Paused", hint: "You paused it. Nothing more starts until you continue." },
  capped: {
    label: "At the spending limit",
    hint: "The next request could pass the limit, so nothing more starts until you continue."
  },
  done: { label: "Done", hint: "Every older message is summarized." }
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
  const state = backfillStates[backfill.state]
  const money = (amount: number | null) =>
    amount !== null && backfill.currency ? ` (${moneyText(amount, backfill.currency)})` : ""
  return (
    <section
      aria-label="Catching up"
      data-testid="backfill"
      data-state={backfill.state}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-sm">
        <Tooltip label="Summarizing the messages the chat had when summaries were turned on.">
          <span
            tabIndex={0}
            className="rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Catching up
          </span>
        </Tooltip>
        <HintBadge tone={backfill.state === "capped" ? "warning" : "accent"} hint={state.hint}>
          {state.label}
        </HintBadge>
        {jobs > 0 && <span className="text-xs text-muted">{backfill.remaining.messages} messages left</span>}
      </div>
      <Tooltip
        label={`Spending stops at ${countText(backfill.capTokens)} tokens${money(backfill.capCost)}, 150% of the estimate, until you continue. Each request counts at the most it could cost before it's sent.`}
      >
        <p
          tabIndex={0}
          className="self-start rounded-sm text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-testid="backfill-spent"
        >
          Spent {countText(backfill.spentTokens)} of {countText(backfill.capTokens)} tokens{money(backfill.spentCost)}
        </p>
      </Tooltip>
      {backfill.state === "capped" && (
        <Alert tone="warning">
          Paused at the spending limit. Continue allows up to 150% of the estimate for what is left.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={backfill.state === "paused" || backfill.state === "capped" ? "primary" : "ghost"}
          disabled={backfill.state !== "paused" && backfill.state !== "capped"}
          focusableWhenDisabled
          pending={pending === "continue"}
          hint={
            backfill.state === "paused" || backfill.state === "capped"
              ? "Continues summarizing the remaining messages."
              : "Catching up is not paused."
          }
          onClick={() => void act("continue")}
        >
          Continue
        </Button>
        <Button
          variant={backfill.state === "waiting" || backfill.state === "running" ? "primary" : "ghost"}
          disabled={backfill.state !== "waiting" && backfill.state !== "running"}
          focusableWhenDisabled
          pending={pending === "summarizeNow"}
          hint={
            backfill.state === "waiting" || backfill.state === "running"
              ? "Summarizes the remaining messages now."
              : "Continue catching up before summarizing now."
          }
          onClick={() => void act("summarizeNow")}
        >
          Summarize now
        </Button>
        <Button
          disabled={backfill.state !== "running"}
          focusableWhenDisabled
          pending={pending === "pause"}
          hint={
            backfill.state === "running"
              ? "Pauses catching up after the current summary."
              : "Catching up is not running."
          }
          onClick={() => void act("pause")}
        >
          Pause
        </Button>
      </div>
      {jobs > 0 && (
        <Disclosure title="Estimate for what is left">
          <EstimateList estimate={backfill.remaining} title="What is left" />
        </Disclosure>
      )}
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
        if (!live) return
        if (!result.ok) {
          showToast({ title: "This summary is no longer available on this branch." })
          return
        }
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
  // Under the user's own summary of a wider range, a request changes nothing the model reads.
  // One over the same range (a failed redo of it) is offered beside it in Revisions, so it stays.
  const blockedByManual = (s: LcmSummary) =>
    lcm.layer.some(
      (parent) =>
        parent.id !== s.id &&
        parent.origin !== "generated" &&
        parent.from <= s.from &&
        parent.to >= s.to &&
        (parent.level > s.level || parent.from !== s.from || parent.to !== s.to)
    )
  const extra = wanted !== null && fetched?.id === wanted ? fetched : null
  const unfinished = lcm.jobs.filter(
    (job) =>
      job.status !== "failed" ||
      !lcm.failed.some((s) => s.level === job.level && s.from === job.from && s.to === job.to)
  )
  const heading = (label: string, hint: string) => (
    <Tooltip label={hint}>
      <h3
        tabIndex={0}
        className="self-start rounded-sm text-xs font-medium tracking-wide text-muted uppercase outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {label}
      </h3>
    </Tooltip>
  )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Tooltip label="What the model reads in place of the older messages. New ones are written with your next reply, or at once with Summarize now.">
          <p
            tabIndex={0}
            className="self-start rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-testid="summary-panel-heading"
          >
            {boundaryText(lcm)}
          </p>
        </Tooltip>
        {lcm.enabled ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <TimelineToggle />
            <Tooltip label="See which summary covers each message, as bars beside the messages. Click one to open its summary.">
              <span className="inline-flex">
                <Switch
                  checked={viewer.prefs.coverageRail}
                  disabled={!viewer.ready || viewer.pending}
                  onCheckedChange={(coverageRail) => void viewer.change({ coverageRail })}
                >
                  Coverage rail
                </Switch>
              </span>
            </Tooltip>
          </div>
        ) : (
          <Alert
            tone="warning"
            actions={
              <Tooltip label="Asks how to start and shows what it costs first.">
                <Button variant="primary" onClick={onEnable}>
                  Enable summaries
                </Button>
              </Tooltip>
            }
          >
            Summaries are off for this chat.
          </Alert>
        )}
        {viewer.error && <Problem error={viewer.error} />}
      </div>
      {lcm.enabled && <Backfill session={session} lcm={lcm} />}
      {unfinished.length > 0 && (
        <section className="flex flex-col gap-2">
          {heading("Being written", "Summaries queued or being written now.")}
          <ul aria-label="Work in progress" className="flex flex-col gap-2">
            {unfinished.map((job) => (
              <JobRow key={job.id} session={session} job={job} onJump={onJump} />
            ))}
          </ul>
        </section>
      )}
      {lcm.failed.length > 0 && (
        <section className="flex flex-col gap-2">
          {heading("Failed", "Summaries that couldn't be written. Their messages are sent as they are while they fit.")}
          <ul aria-label="Failed summaries" className="flex flex-col gap-2">
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
        </section>
      )}
      {lcm.layer.length > 0 ? (
        <section className="flex flex-col gap-2">
          {heading(
            "Sent to the model",
            "The summaries the model reads, oldest first, each in place of the messages it covers."
          )}
          <ul aria-label="Summaries in use" className="flex flex-col gap-2">
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
        </section>
      ) : (
        <p className="text-sm text-muted">
          Nothing is summarized yet. Summaries appear as the chat outgrows what the model is sent.
        </p>
      )}
      {extra !== null && (
        <section aria-label="Not in use" className="flex flex-col gap-2">
          {heading(
            "Not sent itself",
            "A summary condensed into a higher level: the model reads the higher one instead."
          )}
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
