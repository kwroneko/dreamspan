// The request inspector (DESIGN §7.4): the context one reply was generated from, as it was
// sent. Each message with its role, where its text came from, its tokens and the cache
// breakpoints between them; then the model, the samplers and what the provider reported.
// Text is shown as text. Measured virtual rows keep dense contexts bounded; collapsed
// messages render only their previews.
import type { ChatId, VersionId } from "@rp/shared/chat.ts"
import { BUILTIN_PRESET_LABEL } from "@rp/shared/generation.ts"
import type { ContextMessage, RunContext, InspectorUsage, SourceActivation } from "@rp/shared/inspectorApi.ts"
import { Link, Navigate, useParams } from "@tanstack/react-router"
import { useMemo, useRef, useState } from "react"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { AsyncView } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Alert, Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"

/** How much of a collapsed message shows. */
const PREVIEW = 200

const count = (n: number | null) => (n === null ? "unknown" : n.toLocaleString())

const breakpointText = {
  summary: "Cache breakpoint: the end of the summary layer",
  prefix: "Cache breakpoint: the end of the preset's part",
  pinned: "Cache breakpoint: the end of the lore pinned above the history",
  history: "Cache breakpoint: the end of the history the next request repeats"
} as const

const activationText = (activation: SourceActivation): string => {
  if (activation.kind === "note") {
    const on = activation.activation === "explicit" ? "Activated by this chat" : "On in every chat"
    // Older snapshots kept ST's interval; notes go every turn since (DESIGN §4.1).
    const when =
      activation.condition !== undefined
        ? activation.condition
        : activation.interval === null || activation.interval === 1
          ? "every turn"
          : activation.interval === 0
            ? "never due"
            : `every ${activation.interval} user messages; counted ${activation.userMessages}`
    return `${on}; ${when}; ${activation.due ? "due this turn" : "skipped this turn"}.`
  }
  if (activation.status === "skipped") return `Skipped at step ${activation.step}: ${activation.reason}`
  const why =
    activation.why.kind === "constant"
      ? "constant entry"
      : activation.why.kind === "pinned"
        ? "pinned above the history until its start moves"
        : `keyword “${activation.why.primaryKey}”${activation.why.secondaryKeys.length ? `; ${activation.why.logic ?? "and_any"}: ${activation.why.secondaryKeys.map((key) => `“${key}”`).join(", ")}` : ""}`
  const notes =
    activation.why.kind === "keys" && activation.why.notes?.length
      ? `; found in the note${activation.why.notes.length > 1 ? "s" : ""} ${activation.why.notes.map((note) => `“${note}”`).join(", ")}`
      : ""
  return `Activated at step ${activation.step}: ${why}${notes}.`
}

function Message({
  message,
  index,
  chatId,
  open,
  setOpen
}: {
  message: ContextMessage
  index: number
  chatId: ChatId
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const preview = message.content.length > PREVIEW ? `${message.content.slice(0, PREVIEW)}…` : message.content
  return (
    <div className="flex flex-col gap-2">
      <details
        open={open}
        className="rounded-lg border border-border bg-surface"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer flex-col gap-1 px-3 py-2">
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted tabular-nums">#{index + 1}</span>
            <span className="font-medium">{message.role}</span>
            {message.prefill && (
              <Badge>
                {message.prefill.protocol === "deepseek_prefix"
                  ? "DeepSeek prefix: true"
                  : "Forced tool schema prefill"}
              </Badge>
            )}
            {message.name && <span className="text-muted">({message.name})</span>}
            <span className="text-muted tabular-nums">~{message.tokens.toLocaleString()} tokens</span>
          </span>
          <span className="flex flex-wrap gap-1">
            {message.sources.map((source) => (
              <span key={source.id} className="flex flex-col gap-1">
                {source.slotId ? (
                  <Link to="/chats/$chatId" params={{ chatId }} search={{ slot: source.slotId }}>
                    <Badge tone="accent">{source.label}</Badge>
                  </Link>
                ) : (
                  <Badge>{source.label}</Badge>
                )}
                {source.summary?.stale && (
                  <span className="text-xs text-warning">Stale when this reply was generated.</span>
                )}
                {source.summary?.changed && (
                  <span className="text-xs text-warning">Summary stale or replaced since this reply.</span>
                )}
                {source.activation && (
                  <span className="text-xs break-words text-muted">{activationText(source.activation)}</span>
                )}
              </span>
            ))}
          </span>
          {!open && <span className="line-clamp-2 text-sm break-words text-muted">{preview}</span>}
        </summary>
        {message.prefill?.schema && (
          <pre className="overflow-x-auto border-t border-border px-3 py-2 text-xs" aria-label="Prefill schema">
            {message.prefill.schema}
          </pre>
        )}
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
    <div>
      <div className="flex flex-col gap-3 sm:hidden" aria-label="Usage by attempt">
        {requests.map((request, i) => (
          <dl
            key={request.id}
            className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border py-2 text-sm tabular-nums"
          >
            {[
              ["Attempt", `${i + 1}: ${request.status}${request.usageSource === "estimated" ? " (estimated)" : ""}`],
              ["Input", count(request.counts.inputUncached)],
              ["Cache read", count(request.counts.cacheRead)],
              ["Cache write", count(request.counts.cacheWrite)],
              ["Output", count(request.counts.output)],
              ["Cost", request.cost ? `${request.cost.amount.toFixed(4)} ${request.cost.currency}` : "unknown"]
            ].map(([label, value]) => (
              <div key={label} className={label === "Attempt" ? "col-span-2" : ""}>
                <dt className="text-muted">{label}</dt>
                <dd className="whitespace-nowrap">{value}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
      <table className="w-full text-left text-sm tabular-nums max-sm:hidden [&_td]:whitespace-nowrap">
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
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const [focused, setFocused] = useState<number | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable instance; memoization is disabled above
  const virtualizer = useVirtualizer({
    count: run.messages.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 120,
    overscan: 4,
    rangeExtractor: (range) => {
      const visible = defaultRangeExtractor(range)
      return focused === null || visible.includes(focused) ? visible : [...visible, focused].sort((a, b) => a - b)
    },
    gap: 8
  })
  return (
    <div ref={parent} role="list" className="h-[65vh] overflow-y-auto">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            role="listitem"
            aria-posinset={item.index + 1}
            aria-setsize={run.messages.length}
            onFocusCapture={() => setFocused(item.index)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null)
            }}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <Message
              message={run.messages[item.index]!}
              index={item.index}
              chatId={run.chatId}
              open={expanded.has(item.index)}
              setOpen={(open) =>
                setExpanded((previous) => {
                  if (previous.has(item.index) === open) return previous
                  const next = new Set(previous)
                  if (open) next.add(item.index)
                  else next.delete(item.index)
                  return next
                })
              }
            />
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
            {run.preset.label ?? BUILTIN_PRESET_LABEL} ({run.preset.scope})
          </dd>
          <dt className="text-muted">Generation</dt>
          <dd>
            {run.type}, {run.mode === "st" ? "SillyTavern-compatible (earlier assembler)" : "the preset's layout"};{" "}
            {run.status}
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
        {run.capture === "unavailable" ? (
          <p className="text-sm text-muted">Not sent / unavailable: no sanitized final request capture is stored.</p>
        ) : (
          <Messages key={run.versionId} run={run} />
        )}
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
