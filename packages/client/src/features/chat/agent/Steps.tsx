// An agent reply's steps (spec/AGENTIC.md §5.1; DESIGN §7.4): inline in the version, above its
// reasoning and text. While the reply is written, "Working…" with every step as it comes, open
// by default; folded once the reply is done, as "3 steps · 14 s". Folding or opening it during a
// run becomes the user's choice for every reply after (`steps` in the display preferences), as
// reasoning's does. A finished reply's steps are read from its transcript when first opened. The
// header badge (`StepsBadge`) opens the same element. A call waiting for the user keeps the element
// open, and the badge says so; what a step offers under its row is registered (`stepActions`).
import { useAtom, useAtomValue } from "@effect/atom-react"
import type { RolloutStep } from "@rp/shared/agent.ts"
import type { PathEntry, Version } from "@rp/shared/chat.ts"
import type { ReasoningDisplay } from "@rp/shared/chatApi.ts"
import { displayToolData } from "@rp/shared/toolData.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useId, useState } from "react"
import { Icon, type IconName } from "../../../ui/Icon.tsx"
import { Spinner } from "../../../ui/Spinner.tsx"
import { Tooltip } from "../../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../../ui/viewPrefs.ts"
import { liveSteps, type ChatSession } from "../session.ts"
import { excerpt, isOpen, statusText, stepsChoice, stepsText, stepsView } from "./steps.ts"
import { useStepActions, waitsForUser } from "./stepActions.ts"

const effectIcon: Record<Extract<RolloutStep, { kind: "tool" }>["effect"], IconName> = {
  read: "search",
  chat_state: "edit",
  external: "external"
}

interface Stored {
  readonly id: string
  readonly steps: ReadonlyArray<RolloutStep> | null
  readonly error: string | null
}

/** Finished replies' steps by version, read once a page: a finished run's transcript doesn't change. */
const reads = new Map<string, Promise<Stored>>()

/** A finished reply's steps, read when first opened; null until they've come. */
function useStoredSteps(session: ChatSession, version: Version, wanted: boolean) {
  const [stored, setStored] = useState<Stored | null>(null)
  const id = version.id
  useEffect(() => {
    if (!wanted) return
    let active = true
    let read = reads.get(id)
    if (!read) {
      read = session
        .call((client) => client("GetRolloutSteps", { versionId: id }))
        .then((result) =>
          result.ok
            ? { id, steps: result.value, error: null }
            : (reads.delete(id), { id, steps: null, error: `The steps couldn't be read: ${result.error.message}` })
        )
      reads.set(id, read)
    }
    void read.then((value) => active && setStored(value))
    return () => {
      active = false
    }
  }, [wanted, id, session])
  return stored?.id === id ? stored : null
}

export function StepRow({
  step,
  index,
  version,
  session
}: {
  step: RolloutStep
  index: number
  version: Version
  session: ChatSession
}) {
  const [open, setOpen] = useState(false)
  const actions = useStepActions()
  const id = useId()
  const body = step.kind === "tool" ? (step.result ?? "") : step.text
  const canOpen = body.trim() !== ""
  const what =
    step.kind === "tool" ? "what the tool returned" : step.kind === "thinking" ? "this thinking" : "this text"
  return (
    <li className="flex flex-col gap-1" data-step={step.kind} data-step-index={index}>
      <div className="flex min-w-0 items-start gap-1.5 text-xs">
        <Tooltip label={canOpen ? `Click to ${open ? "hide" : "show"} ${what}` : "Nothing came back from this step."}>
          <button
            type="button"
            aria-expanded={canOpen ? open : undefined}
            aria-controls={canOpen ? id : undefined}
            aria-disabled={canOpen ? undefined : true}
            onClick={() => canOpen && setOpen(!open)}
            className="-ml-1 flex min-w-0 items-start gap-1.5 rounded-md px-1 py-0.5 text-left text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus aria-disabled:hover:bg-transparent"
          >
            <Icon name={open ? "down" : "right"} size={14} className={canOpen ? "mt-px" : "invisible mt-px"} />
            <Icon
              name={step.kind === "tool" ? effectIcon[step.effect] : step.kind === "thinking" ? "reasoning" : "note"}
              size={14}
              className="mt-px"
            />
            {step.kind === "tool" ? (
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-medium text-text">{step.label}</span>
                {step.title && <span> {step.title}</span>}
                {step.subtitle && <span className="block text-muted">{step.subtitle}</span>}
              </span>
            ) : (
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-medium text-text">{step.kind === "thinking" ? "Thought" : "Wrote"}</span>{" "}
                {!open && (step.text.trim() ? excerpt(step.text) : "nothing")}
              </span>
            )}
          </button>
        </Tooltip>
        {step.kind === "tool" && (
          <span className="mt-0.5 ml-auto flex shrink-0 items-center" data-step-status={step.status}>
            {step.status === "running" ? (
              <Spinner className="size-3.5" />
            ) : step.status === "waiting" ? (
              <Icon name="help" size={14} className="text-warning" />
            ) : (
              <Icon
                name={step.status === "done" ? "check" : "close"}
                size={14}
                className={step.status === "done" ? "text-success" : "text-danger"}
              />
            )}
            <span className="sr-only">{statusText[step.status]}</span>
          </span>
        )}
      </div>
      {open && canOpen && (
        <pre
          id={id}
          className="ml-5 max-h-64 overflow-auto rounded-md border border-border bg-canvas px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-muted [overflow-wrap:anywhere]"
        >
          {step.kind === "tool" ? displayToolData(body) : body}
        </pre>
      )}
      {step.kind === "tool" &&
        actions.map((action) => <action.component key={action.id} step={step} version={version} session={session} />)}
    </li>
  )
}

export function Steps({ version, session }: { version: Version; session: ChatSession }) {
  const live = useAtomValue(liveSteps(version.id))
  const generating = version.status === "generating"
  const view = stepsView(live, version.steps, generating)
  // The last steps streamed, shown at once if the element is opened right after the reply ends.
  const [lastLive, setLastLive] = useState<{ id: string; steps: ReadonlyArray<RolloutStep> } | null>(null)
  if (live !== null && live.length > 0 && (lastLive?.id !== version.id || lastLive.steps !== live))
    setLastLive({ id: version.id, steps: live })
  const viewer = useViewPrefs()
  const preferred: ReasoningDisplay = viewer.prefs.steps
  const [chosen, setChosen] = useAtom(stepsChoice(version.id))
  const streaming = view?.running ?? false
  // A call waiting for the user stays in sight: the answer is in its row.
  const waiting = waitsForUser(view?.live)
  const open = view !== null && (waiting || isOpen(chosen, streaming, preferred))
  const stored = useStoredSteps(session, version, open && view !== null && !view.running)
  const id = useId()
  const hintId = useId()
  if (view === null) return null

  const hint = waiting
    ? "The assistant is waiting for your answer below."
    : open
      ? streaming
        ? "Click to hide the steps. Replies after this one show them folded too."
        : "Click to hide the steps"
      : streaming
        ? "Click to show the steps as they happen. Replies after this one show them open too."
        : "Click to show the steps behind this reply"
  const toggle = () => {
    if (waiting) return
    setChosen({ open: !open, streaming })
    // During a run the choice sticks: later replies show their steps that way too (DESIGN §7.4).
    if (streaming) {
      const steps: ReasoningDisplay = open ? "collapsed" : "expanded"
      if (steps !== preferred) void viewer.change({ steps })
    }
  }
  const steps = view.live ?? stored?.steps ?? (lastLive?.id === version.id ? lastLive.steps : null)

  return (
    <div className="flex flex-col gap-1" data-steps-panel={streaming ? "running" : "done"}>
      <div className="flex flex-wrap items-center gap-x-2">
        <Tooltip label={hint}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-describedby={hintId}
            aria-disabled={waiting || undefined}
            onClick={toggle}
            className="-ml-1 flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name={open ? "down" : "right"} size={14} />
            <Icon name="tool" size={14} />
            {streaming ? (
              <>
                {waiting ? (
                  <span className="font-medium text-text" data-waiting="">
                    Waiting for you
                  </span>
                ) : (
                  <span className="animate-pulse font-medium motion-reduce:animate-none" data-working="">
                    Working…
                  </span>
                )}
                {view.count > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{stepsText(view.count, null)}</span>
                  </>
                )}
              </>
            ) : (
              <span className="font-medium">{stepsText(view.count, view.ms)}</span>
            )}
          </button>
        </Tooltip>
        <span id={hintId} hidden>
          {hint}
        </span>
      </div>
      {open && (
        <div
          id={id}
          role="region"
          aria-label="Steps"
          aria-busy={streaming ? true : undefined}
          className="flex flex-col gap-1.5 border-l-2 border-border pl-3"
        >
          {steps === null ? (
            stored?.error ? (
              <p role="alert" className="text-xs text-danger">
                {stored.error}
              </p>
            ) : (
              <p className="text-xs text-muted">Loading the steps…</p>
            )
          ) : steps.length === 0 ? (
            <p className="text-xs text-muted">No steps were kept for this reply.</p>
          ) : (
            <ol className="flex flex-col gap-1" aria-label="Steps of this reply">
              {steps.map((step, i) => (
                <StepRow
                  key={step.kind === "tool" ? step.id : `${step.kind}-${i}`}
                  step={step}
                  index={i}
                  version={version}
                  session={session}
                />
              ))}
            </ol>
          )}
          {!streaming && version.context !== null && (
            <Tooltip label="Open this reply's run in the inspector">
              <Link
                to="/chats/$chatId/context/$versionId"
                params={{ chatId: session.id, versionId: version.id }}
                search={session.snapshot().forkId === null ? {} : { fork: session.snapshot().forkId! }}
                hash="run-steps"
                className="w-fit text-xs text-muted underline-offset-2 hover:text-text hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                Open the run
              </Link>
            </Tooltip>
          )}
        </div>
      )}
      {viewer.error && (
        <p role="alert" className="text-xs text-danger">
          Your choice wasn’t saved: {viewer.error.message}
        </p>
      )}
    </div>
  )
}

/**
 * "3 steps · 14 s" in the message header (spec/AGENTIC.md §5.1), for a reply whose run made tool
 * calls; nothing for a plain one. A click opens or folds the steps in the message.
 */
export function StepsBadge({ entry }: { entry: PathEntry; session: ChatSession; generating: boolean }) {
  const version = entry.version
  const live = useAtomValue(liveSteps(version.id))
  const generating = version.status === "generating"
  const view = stepsView(live, version.steps, generating)
  const viewer = useViewPrefs()
  const [chosen, setChosen] = useAtom(stepsChoice(version.id))
  if (view === null || view.count === 0) return null
  const streaming = view.running
  const waiting = waitsForUser(view.live)
  const open = waiting || isOpen(chosen, streaming, viewer.prefs.steps)
  return (
    <Tooltip
      label={
        waiting
          ? "The assistant is waiting for your answer. Click to go to it."
          : open
            ? "Click to hide the steps"
            : "Click to show the steps behind this reply"
      }
    >
      <button
        type="button"
        aria-pressed={open}
        data-steps-badge=""
        onClick={(event) => {
          if (waiting) {
            const asked = event.currentTarget.closest("article")?.querySelector("[data-approval]")
            asked?.scrollIntoView({ block: "nearest" })
            return
          }
          setChosen({ open: !open, streaming })
          if (streaming) {
            const steps: ReasoningDisplay = open ? "collapsed" : "expanded"
            if (steps !== viewer.prefs.steps) void viewer.change({ steps })
          }
          if (!open) {
            const panel = event.currentTarget.closest("article")?.querySelector("[data-steps-panel]")
            requestAnimationFrame(() => panel?.scrollIntoView({ block: "nearest" }))
          }
        }}
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-xs font-medium whitespace-nowrap text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:text-text"
      >
        <Icon name={waiting ? "help" : "tool"} size={12} />
        {waiting ? "Waiting for you" : stepsText(view.count, view.ms)}
      </button>
    </Tooltip>
  )
}
