// The request inspector (DESIGN §7.4): the context one reply was generated from, as it was
// sent. Each message with its role, where its text came from, its tokens and the cache
// breakpoints between them; then the model, the samplers and what the provider reported.
// Text is shown as text. Measured virtual rows keep dense contexts bounded; collapsed
// messages render only their previews.
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import type { ContextMessage, RunContext, InspectorUsage } from "@rp/shared/inspectorApi.ts"
import { Link, Navigate, useParams } from "@tanstack/react-router"
import { useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AsyncView } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"

/** How much of a collapsed message shows. */
const PREVIEW = 200

const count = (n: number | null) => (n === null ? "unknown" : n.toLocaleString())

const breakpointText = {
  prefix: "Cache breakpoint: the end of the preset's part",
  history: "Cache breakpoint: the end of the history the next request repeats"
} as const

function Message({ message, index, chatId }: { message: ContextMessage; index: number; chatId: ChatId }) {
  const [open, setOpen] = useState(false)
  const preview = message.content.length > PREVIEW ? `${message.content.slice(0, PREVIEW)}…` : message.content
  return (
    <div className="flex flex-col gap-2">
      <details
        className="rounded-lg border border-border bg-surface"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer flex-col gap-1 px-3 py-2">
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted tabular-nums">#{index + 1}</span>
            <span className="font-medium">{message.role}</span>
            {message.name && <span className="text-muted">({message.name})</span>}
            <span className="text-muted tabular-nums">~{message.tokens.toLocaleString()} tokens</span>
          </span>
          <span className="flex flex-wrap gap-1">
            {message.sources.map((source) =>
              source.slotId ? (
                <Link key={source.label} to="/chats/$chatId" params={{ chatId }} search={{ slot: source.slotId }}>
                  <Badge tone="accent">{source.label}</Badge>
                </Link>
              ) : (
                <Badge key={source.label}>{source.label}</Badge>
              )
            )}
          </span>
          {!open && <span className="line-clamp-2 text-sm break-words text-muted">{preview}</span>}
        </summary>
        {open && (
          <p className="border-t border-border px-3 py-2 text-sm break-words whitespace-pre-wrap">{message.content}</p>
        )}
      </details>
      {message.breakpoint && (
        <p className="border-t-2 border-dashed border-accent pt-1 text-xs text-accent">
          {breakpointText[message.breakpoint]}
        </p>
      )}
    </div>
  )
}

function Usage({ requests }: { requests: ReadonlyArray<InspectorUsage> }) {
  if (requests.length === 0) return <p className="text-sm text-muted">No request was sent.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm tabular-nums">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Attempt</th>
            <th className="py-1 pr-3 font-medium">Input</th>
            <th className="py-1 pr-3 font-medium">Cache read</th>
            <th className="py-1 pr-3 font-medium">Cache write</th>
            <th className="py-1 pr-3 font-medium">Output</th>
            <th className="py-1 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request, i) => (
            <tr key={request.id} className="border-t border-border">
              <td className="py-1 pr-3">
                {i + 1}: {request.status}
                {request.usageSource === "estimated" && " (estimated)"}
              </td>
              <td className="py-1 pr-3">{count(request.counts.inputUncached)}</td>
              <td className="py-1 pr-3">{count(request.counts.cacheRead)}</td>
              <td className="py-1 pr-3">{count(request.counts.cacheWrite)}</td>
              <td className="py-1 pr-3">{count(request.counts.output)}</td>
              <td className="py-1">
                {request.cost ? `${request.cost.amount.toFixed(4)} ${request.cost.currency}` : "unknown"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Messages({ run }: { run: RunContext }) {
  "use no memo"
  const parent = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable instance; memoization is disabled above
  const virtualizer = useVirtualizer({
    count: run.messages.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 120,
    overscan: 4,
    gap: 8
  })
  return (
    <div ref={parent} role="list" className="h-[65vh] overflow-y-auto">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            role="listitem"
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <Message message={run.messages[item.index]!} index={item.index} chatId={run.chatId} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Inspector({ run }: { run: RunContext }) {
  const tokens = run.messages.reduce((sum, m) => sum + m.tokens, 0)
  const breakpointsSent = run.model?.breakpoints === "explicit"
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Request"
          description={`Built ${new Date(run.builtAt).toLocaleString()}: ${run.messages.length} messages, about ${tokens.toLocaleString()} tokens.`}
        />
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Model</dt>
          <dd>{run.model ? `${run.model.model} on ${run.model.connection} (${run.model.kind})` : "none"}</dd>
          <dt className="text-muted">Preset</dt>
          <dd>
            {run.preset.label ?? "SillyTavern's default"} ({run.preset.scope})
          </dd>
          <dt className="text-muted">Generation</dt>
          <dd>
            {run.type}, {run.mode === "st" ? "SillyTavern-compatible" : "our layouts"}; {run.status}
          </dd>
          <dt className="text-muted">Breakpoints</dt>
          <dd>
            {breakpointsSent
              ? "sent to the provider"
              : "marked here, not sent: the model's breakpoints aren't explicit"}
          </dd>
          <dt className="text-muted">Samplers</dt>
          <dd className="break-words">
            {Object.entries(run.samplers)
              .map(([name, value]) => `${name} ${value}`)
              .join(", ")}
          </dd>
        </dl>
      </Card>
      {run.issues.length > 0 && (
        <Alert tone="warning" title="Notes on this context">
          <ul className="list-disc pl-5">
            {run.issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card>
        <CardHeader title="Usage" description="What the provider reported, per attempt." />
        <Usage requests={run.requests} />
      </Card>
      <section aria-label="Messages" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Messages</h2>
        <Messages run={run} />
      </section>
    </div>
  )
}

/** /chats/$chatId/context/$versionId */
export function ContextPage() {
  const { chatId, versionId } = useParams({ strict: false }) as { chatId: ChatId; versionId: VersionId }
  useTitle("Context")
  const atom = useMemo(() => AppClient.query("GetRunContext", { versionId }), [versionId])
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Context of a reply</h1>
      </header>
      <AsyncView atom={atom} loading="Loading the context…">
        {(run) =>
          run.chatId !== chatId ? (
            <Navigate to="/chats/$chatId/context/$versionId" params={{ chatId: run.chatId, versionId }} replace />
          ) : (
            <>
              <Link
                to="/chats/$chatId"
                params={{ chatId: run.chatId }}
                search={{ slot: run.slotId }}
                className="text-sm text-muted hover:text-text"
              >
                ← Back to the reply
              </Link>
              <Inspector run={run} />
            </>
          )
        }
      </AsyncView>
    </div>
  )
}
