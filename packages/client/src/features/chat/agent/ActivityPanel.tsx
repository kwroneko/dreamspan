// The Activity tab (spec/AGENTIC.md §5.4; DESIGN §7.4): the chat's model work that made no
// message, newest first: summaries, condensations, judgments of replies. Each row says what it
// was, how it ended, the model, when, its tokens and cost, and links to where it can be looked at
// (a summary's request, or the reply a judgment was about). Agent replies are reached from their
// message instead. Read in pages of 50 (`ListActivity`), again whenever the summaries change.
import type { ActivityCursor, ActivityRow } from "@rp/shared/agent.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import type { RequestStatus } from "@rp/shared/usage.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Button } from "../../../ui/Button.tsx"
import { Badge } from "../../../ui/Surface.tsx"
import { Tooltip } from "../../../ui/Tooltip.tsx"
import type { PanelProps } from "../panels.tsx"
import { requestPurposeText, requestStatusText } from "../requestWords.ts"
import type { ChatSession } from "../session.ts"
import { durationText } from "./steps.ts"

const count = (n: number | null) => (n === null ? "unknown" : n.toLocaleString())

const statusOf = (status: string) =>
  status in { running: 1, complete: 1, failed: 1, aborted: 1, interrupted: 1 }
    ? requestStatusText(status as RequestStatus)
    : status

const tone = (status: string) =>
  status === "failed" ? "danger" : status === "running" ? "accent" : status === "complete" ? "neutral" : "warning"

/** Total input, cache included, as the request inspector counts it. */
const inputOf = (row: ActivityRow) =>
  row.input === null ? null : row.input + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0)

function Row({ row, session, onJump }: { row: ActivityRow; session: ChatSession; onJump: (slot: SlotId) => void }) {
  const status = statusOf(row.status)
  const figures: ReadonlyArray<readonly [string, string]> = [
    ["Input", count(inputOf(row))],
    ["Cached", count(row.cacheRead)],
    ["Output", count(row.output)],
    ["Cost", row.cost ? `${row.cost.amount.toFixed(4)} ${row.cost.currency}` : "unknown"]
  ]
  return (
    <li
      className="flex flex-col gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-sm"
      data-activity={row.kind}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{requestPurposeText(row.kind)}</span>
        <Badge tone={tone(row.status)}>{status}</Badge>
        {row.requests > 1 && <span className="text-xs text-muted">{row.requests} requests</span>}
      </div>
      <p className="text-xs text-muted [overflow-wrap:anywhere]">
        {row.model ?? "Unknown model"}
        {row.connection && ` on ${row.connection}`} · {new Date(row.startedAt).toLocaleString()}
        {row.endedAt !== null && ` · ${durationText(row.endedAt - row.startedAt)}`}
      </p>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums">
        {figures.map(([label, value]) => (
          <div key={label} className="flex gap-1">
            <dt className="text-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {row.estimated && <div className="text-muted">(some counts estimated)</div>}
      </dl>
      {row.summaryId !== null && (
        <Tooltip label="Open the request that wrote this summary in the inspector">
          <Link
            to="/chats/$chatId/summaries/$summaryId/request"
            params={{ chatId: session.id, summaryId: row.summaryId }}
            search={row.summaryRevisionId === null ? {} : { revision: row.summaryRevisionId }}
            className="w-fit text-xs text-accent underline-offset-2 hover:underline"
          >
            Open request
          </Link>
        </Tooltip>
      )}
      {row.slotId !== null && (
        <Tooltip label="Show the reply this was about in the chat">
          <button
            type="button"
            onClick={() => onJump(row.slotId as SlotId)}
            className="w-fit rounded-sm text-left text-xs text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            Go to the reply
          </button>
        </Tooltip>
      )}
    </li>
  )
}

export function ActivityPanel({ session, view, active, onJump }: PanelProps) {
  const [rows, setRows] = useState<ReadonlyArray<ActivityRow> | null>(null)
  const [before, setBefore] = useState<ActivityCursor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // The summaries changing is what adds a row here; read again then, and when the tab is shown.
  const lcm = view.lcm
  useEffect(() => {
    if (!active) return
    let current = true
    void session
      .call((client) => client("ListActivity", { chatId: session.id }))
      .then((result) => {
        if (!current) return
        if (result.ok) {
          setRows(result.value.rows)
          setBefore(result.value.before)
          setError(null)
        } else setError(`The activity couldn't be read: ${result.error.message}`)
      })
    return () => {
      current = false
    }
  }, [session, active, lcm])
  const older = async () => {
    if (before === null) return
    setLoading(true)
    const result = await session.call((client) => client("ListActivity", { chatId: session.id, before }))
    setLoading(false)
    if (result.ok) {
      setRows([...(rows ?? []), ...result.value.rows])
      setBefore(result.value.before)
    } else setError(`The activity couldn't be read: ${result.error.message}`)
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">Model work in this chat that wrote no message, newest first.</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {rows === null ? (
        !error && <p className="text-sm text-muted">Loading the activity…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. Summaries and checks of replies show here.</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Activity">
          {rows.map((row) => (
            <Row key={`${row.id}-${row.kind}`} row={row} session={session} onJump={onJump} />
          ))}
        </ol>
      )}
      {before !== null && (
        <Button
          className="self-start"
          pending={loading}
          hint="Shows the next 50, older ones."
          onClick={() => void older()}
        >
          Show older
        </Button>
      )}
    </div>
  )
}
