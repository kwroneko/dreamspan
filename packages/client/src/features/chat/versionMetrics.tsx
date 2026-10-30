// A reply's generation time and tokens in its header (parity finding 5; the
// `message.header-details` slot): elapsed seconds and output tokens, summed over the
// requests behind its text (retries, and the versions it continued), from the usage ledger
// (`GetVersionMetrics`). Its tooltip, and the panel a click opens, give time to first token,
// reasoning time, tokens per second and the last request apart. Unknown figures say so.
import type { PathEntry } from "@rp/shared/chat.ts"
import type { VersionMetrics } from "@rp/shared/inspectorApi.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Popover } from "../../ui/Popover.tsx"
import { messageHeaderDetails } from "./presentation.tsx"
import { MetricsLoader } from "./metricsLoader.ts"
import type { ChatSession } from "./session.ts"

const loaders = new WeakMap<ChatSession, MetricsLoader>()
const loaderOf = (session: ChatSession) => {
  let loader = loaders.get(session)
  if (!loader) loaders.set(session, (loader = new MetricsLoader(session)))
  return loader
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const count = (n: number) => n.toLocaleString()

/** The header's short form: "12.3 s · 340 tokens". */
export const metricsSummary = (m: VersionMetrics) => {
  const time = m.elapsedMs === null ? "time unknown" : seconds(m.elapsedMs)
  const ended = m.requests - (m.running ? 1 : 0)
  const tokens =
    ended === 0 || m.outputUnknown === ended
      ? "tokens unknown"
      : `${m.estimated ? "~" : ""}${count(m.output)}${m.outputUnknown > 0 ? "+" : ""} tokens`
  return `${time} · ${tokens}`
}

/** The full figures, one per line. */
export const metricsDetails = (m: VersionMetrics, hasReasoning: boolean): ReadonlyArray<[string, string]> => {
  const last = m.last
  const firstToken =
    last.firstTokenAt === null ? (m.running ? "waiting" : "unknown") : seconds(last.firstTokenAt - last.startedAt)
  const rate =
    m.streamingMs !== null && m.streamingMs > 0 && m.output > 0 && m.outputUnknown === 0
      ? `${(m.output / (m.streamingMs / 1000)).toFixed(1)} tokens/s${m.estimated ? " (estimated count)" : ""}`
      : "unknown"
  const ended = m.requests - (m.running ? 1 : 0)
  const output =
    ended === 0 || m.outputUnknown === ended
      ? "unknown (no request reported a count)"
      : m.outputUnknown > 0
        ? `${count(m.output)} counted${m.estimated ? " (estimated)" : ""}; ${m.outputUnknown === 1 ? "1 request" : `${m.outputUnknown} requests`} reported none`
        : `${count(m.output)}${m.estimated ? " (estimated)" : ""}`
  const rows: Array<[string, string]> = [
    ["Generation time", m.elapsedMs === null ? "unknown" : seconds(m.elapsedMs)],
    ["Time to first token", `${firstToken}${m.requests > 1 ? " (last request)" : ""}`],
    ["Output tokens", output],
    ["Speed", rate]
  ]
  if (hasReasoning) {
    rows.push(["Reasoning tokens", m.reasoning === null ? "unknown" : count(m.reasoning)])
    rows.push(["Reasoning time", "not recorded"])
  }
  if (m.requests > 1) {
    rows.push(["Requests", `${m.requests} (includes original generation, retries and continuations)`])
    rows.push([
      "Last request",
      `${last.endedAt === null ? "running" : seconds(last.endedAt - last.startedAt)}, ${
        last.output === null
          ? "tokens unknown"
          : `${count(last.output)} tokens${last.usageSource === "estimated" ? " (estimated)" : ""}`
      }`
    ])
  }
  return rows
}

function Metrics({ entry, session, generating }: { entry: PathEntry; session: ChatSession; generating: boolean }) {
  const { version } = entry
  const loader = loaderOf(session)
  const key = version.status
  const metrics = useSyncExternalStore(loader.subscribe, () => loader.peek(version.id, key))
  const [open, setOpen] = useState(false)
  const wanted = version.writer === "model" && !generating
  useEffect(() => {
    if (wanted) loader.want(version.id, key)
  }, [loader, wanted, version.id, key])
  if (!wanted || !metrics) return null
  const rows = metricsDetails(metrics, Boolean(version.reasoning))
  const summary = metricsSummary(metrics)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="Generation"
      triggerLabel={`Generation: ${summary}`}
      triggerClassName="shrink-0 rounded-sm text-xs text-muted tabular-nums outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      trigger={summary}
      hint={rows.map(([label, value]) => (
        <div key={label}>
          {label}: {value}
        </div>
      ))}
    >
      <dl className="grid min-h-0 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Popover>
  )
}

export const registerVersionMetrics = () => [
  messageHeaderDetails.register({ id: "message.metrics", order: 10, component: Metrics })
]
