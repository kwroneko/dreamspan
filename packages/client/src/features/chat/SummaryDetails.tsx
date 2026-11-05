import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import type { LcmSummary, SummaryDetails as Details } from "@rp/shared/lcm.ts"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import { routes } from "../../routes.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Alert, Card, CardHeader } from "../../ui/Surface.tsx"
import { iconButtonClass } from "../../ui/Tooltip.tsx"
import { rangeText } from "./lcm.ts"
import { summaryPreviews } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"
import { moneyText } from "./lcm.ts"
import { requestPurposeText, requestStatusText } from "./requestWords.ts"

const count = (value: number | null) => (value === null ? "Unknown" : value.toLocaleString())
const time = (value: number | null) => (value === null ? "Unknown" : new Date(value).toLocaleString())

/** The request's purpose and how it ended, in words: "Condensing 5 summaries, finished". */
function requestLine(request: Details["requests"][number], details: Details, summary: LcmSummary | undefined) {
  const about =
    summary === undefined
      ? { summaries: details.parts }
      : { from: summary.from, to: summary.to, summaries: details.parts }
  return `${requestPurposeText(request.purpose, about)}, ${requestStatusText(request.status)}`
}

/** `raw`: the inspector page also shows the stored purpose and status, for debugging. */
function Provenance({ details, summary, raw = false }: { details: Details; summary?: LcmSummary; raw?: boolean }) {
  return (
    <div className="flex flex-col gap-2 text-sm" aria-label="Summary generation details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
        <dt>Model</dt>
        <dd>{details.model ?? "Unknown"}</dd>
        <dt>Started</dt>
        <dd>{time(details.startedAt)}</dd>
        <dt>Finished</dt>
        <dd>{time(details.endedAt)}</dd>
        <dt>Time</dt>
        <dd>
          {details.startedAt !== null && details.endedAt !== null
            ? `${((details.endedAt - details.startedAt) / 1000).toLocaleString()} s`
            : "Unknown"}
        </dd>
        <dt>Job attempts</dt>
        <dd>{count(details.attempts)}</dd>
      </dl>
      {details.requests.length === 0 ? (
        <p>Tokens: Unknown. Cost: Unknown. No request usage was recorded.</p>
      ) : (
        <ol aria-label="Summary request usage" className="flex flex-col gap-3">
          {details.requests.map((request, index) => (
            <li key={request.id} className="flex flex-col gap-1 rounded-md border border-border p-2">
              <p className="font-medium">
                Request {index + 1}: {request.responseModel ?? request.modelKey}
              </p>
              <p>
                {requestLine(request, details, summary)}
                {raw && (
                  <span className="text-muted">
                    {" "}
                    (stored as <code>{request.purpose}</code>, <code>{request.status}</code>)
                  </span>
                )}
              </p>
              <p>
                Input: {count(request.counts.inputUncached)} · Cache read: {count(request.counts.cacheRead)} · Cache
                write: {count(request.counts.cacheWrite)} · Output: {count(request.counts.output)} tokens
              </p>
              <p>Cost: {request.cost ? moneyText(request.cost.amount, request.cost.currency) : "Unknown"}</p>
              <p>
                Time:{" "}
                {request.endedAt !== null
                  ? `${((request.endedAt - request.startedAt) / 1000).toLocaleString()} s`
                  : "Unknown"}{" "}
                · Usage: {request.usageSource === "none" ? "Unknown" : request.usageSource}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function SummaryProvenance({ session, summary }: { session: ChatSession; summary: LcmSummary }) {
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<Details | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [read, setRead] = useState(0)
  useEffect(() => {
    if (!open) return
    let live = true
    void session
      .call((client) => client("GetSummaryDetails", { summaryId: summary.id }))
      .then((result) => {
        if (!live) return
        if (result.ok) {
          setDetails(result.value)
          setError(null)
        } else setError(result.error.message)
      })
    return () => {
      live = false
    }
  }, [session, summary.id, open, read])
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<Icon name="info" />}
      triggerLabel={`Details of the summary of ${rangeText(summary.from, summary.to).toLowerCase()}`}
      triggerClassName={iconButtonClass()}
      hint="Details: the model, time, tokens and cost of the request that wrote it"
      title="How it was written"
      side="bottom"
      align="end"
      wide
    >
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        {error ? (
          <Alert
            tone="danger"
            actions={
              <Button hint="Retries loading this summary’s details." onClick={() => setRead(read + 1)}>
                Retry details
              </Button>
            }
          >
            {error}
          </Alert>
        ) : details ? (
          <>
            <Provenance details={details} summary={summary} />
            {details.request ? (
              <Tooltip label="Opens the captured summary request in the inspector.">
                <Link
                  to="/chats/$chatId/summaries/$summaryId/request"
                  params={{ chatId: session.id, summaryId: summary.id }}
                  className="self-start text-sm text-accent underline"
                >
                  Open request in inspector
                </Link>
              </Tooltip>
            ) : (
              <p className="text-sm text-muted">The request itself wasn't kept.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">Loading details…</p>
        )}
      </div>
    </Popover>
  )
}

/** A summary request has no message version. Its registered route reads the stored capture directly. */
function SummaryRequestPage() {
  const { summaryId } = useParams({ strict: false }) as { summaryId: LcmSummary["id"] }
  const search = useSearch({ strict: false }) as { revision?: unknown }
  const revisionId = typeof search.revision === "string" ? (search.revision as LcmSummary["revisionId"]) : null
  const { run } = useAction()
  const [details, setDetails] = useState<Details | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void run((client) =>
      revisionId === null
        ? client("GetSummaryDetails", { summaryId })
        : client("GetSummaryRevisionRequest", { revisionId })
    ).then((result) => {
      if (!live) return
      if (result.ok) {
        setDetails(result.value)
        setError(null)
      } else setError(result.error.message)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run uses the lifetime transport
  }, [summaryId, revisionId])
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <CenterHeaderContent>
        <h1 className="text-lg font-semibold">Summary request inspector</h1>
      </CenterHeaderContent>
      {error && <Alert tone="danger">{error}</Alert>}
      {details && (
        <>
          <Tooltip label="Returns to the summary.">
            <Link
              to="/chats/$chatId"
              params={{ chatId: details.chatId }}
              search={{ ...(details.forkId ? { fork: details.forkId } : {}), panel: "summaries", summary: summaryId }}
              className="text-sm text-accent underline"
            >
              Back to the summary
            </Link>
          </Tooltip>
          <Provenance details={details} raw />
          {details.request ? (
            <>
              <p className="text-sm text-muted">The request, in the order it was sent.</p>
              {details.request.messages.map((message, index) => (
                <Card key={index}>
                  <CardHeader
                    title={`${index + 1}. ${message.role}${message.name ? ` · ${message.name}` : ""}`}
                    description={message.sources.map((source) => source.label).join(" · ")}
                  />
                  <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                    {message.content}
                  </pre>
                </Card>
              ))}
            </>
          ) : (
            <p>The request itself wasn&apos;t kept.</p>
          )}
        </>
      )}
    </div>
  )
}

export const registerSummaryDetails = () => {
  summaryPreviews.register({ id: "summary.generation-details", order: 100, component: SummaryProvenance })
  routes.register({
    id: "summary.request",
    parent: "app",
    path: "/chats/$chatId/summaries/$summaryId/request",
    component: SummaryRequestPage
  })
}
