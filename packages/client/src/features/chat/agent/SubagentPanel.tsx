// A subagent under the `agent` call that started it (spec/SUBAGENTS.md §7): one collapsed row,
// "Subagent · Look things up · name", its model, "N steps · T s · $x" and its status. Opening it
// shows the task and the subagent's own steps, with the same rows (and answers to calls that ask
// first) as the reply's. Stop ends it alone, and the assistant carries on with what it had;
// Inspect opens its own run in the run inspector.
import type { SubagentRow, SubagentStatus } from "@dreamspan/shared/agent.ts"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { ErrorAlert, useAction } from "../../../actions.tsx"
import { Button } from "../../../ui/Button.tsx"
import { Icon } from "../../../ui/Icon.tsx"
import { Spinner } from "../../../ui/Spinner.tsx"
import { Badge } from "../../../ui/Surface.tsx"
import { Tooltip } from "../../../ui/Tooltip.tsx"
import { formatCost } from "../versionMetrics.tsx"
import type { StepActionProps } from "./stepActions.ts"
import { StepRow } from "./Steps.tsx"
import { stepsText } from "./steps.ts"

const statusWords: Record<SubagentStatus, string> = {
  running: "Working",
  waiting: "Waiting for you",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed"
}

const statusTone = {
  running: "neutral",
  waiting: "warning",
  done: "success",
  stopped: "neutral",
  failed: "danger"
} as const

/** "3 steps · 14 s · $0.012", as far as each is known. */
export const subagentFacts = (row: SubagentRow) =>
  [stepsText(row.count, row.ms), ...(row.cost ? [formatCost(row.cost)] : [])].join(" · ")

/** Its model as the row names it: "Same model · key", or the alias the assistant chose and the key. */
const subagentModel = (row: SubagentRow) =>
  row.alias === "same" ? `Same model · ${row.model}` : `${row.alias} · ${row.model}`

export function SubagentPanel({ step, version, session }: StepActionProps) {
  const row = step.subagent
  const [open, setOpen] = useState(false)
  const action = useAction()
  const id = useId()
  if (!row) return null
  const live = row.status === "running" || row.status === "waiting"
  const stop = () =>
    void action.run((client) => client("StopSubagent", { versionId: version.id, rolloutId: row.rolloutId }))
  return (
    <div
      className="ml-5 flex flex-col gap-1.5 rounded-md border border-border bg-surface p-2 text-xs"
      data-subagent={row.handle}
      data-subagent-status={row.status}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip label={open ? "Hides the subagent's task and steps." : "Shows the subagent's task and steps."}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1 py-0.5 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name={open ? "down" : "right"} size={14} className="mt-px shrink-0 text-muted" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-medium text-text">Subagent</span>
              <span className="text-muted"> · {row.typeLabel}</span>
              {row.name && <span className="text-text"> · {row.name}</span>}
              <span className="block text-muted">
                {subagentModel(row)} · {subagentFacts(row)}
              </span>
            </span>
          </button>
        </Tooltip>
        <span className="flex shrink-0 items-center gap-1.5">
          {live && <Spinner className="size-3.5" />}
          <Badge tone={statusTone[row.status]}>{statusWords[row.status]}</Badge>
          {live && (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              pending={action.pending}
              hint="Stops this subagent. The assistant gets what it has so far and carries on."
              onClick={stop}
            >
              Stop
            </Button>
          )}
          <Tooltip label="Opens this subagent's own run: its instructions, tools, requests and costs.">
            <Link
              to="/chats/$chatId/context/$versionId"
              params={{ chatId: session.chatId, versionId: version.id }}
              search={{ subagent: row.rolloutId }}
              className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              Inspect
            </Link>
          </Tooltip>
        </span>
      </div>
      {action.error && <ErrorAlert error={action.error} />}
      {open && (
        <div id={id} className="flex flex-col gap-1.5 pl-5">
          <p className="whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
            <span className="font-medium text-text">Task: </span>
            {row.task}
          </p>
          {(row.steps ?? []).length === 0 ? (
            <p className="text-muted">{live ? "No steps yet." : "It took no steps."}</p>
          ) : (
            <ol className="flex flex-col gap-1" aria-label={`${row.handle}'s steps`}>
              {(row.steps ?? []).map((child, i) => (
                <StepRow key={i} step={child} index={i} version={version} session={session} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
