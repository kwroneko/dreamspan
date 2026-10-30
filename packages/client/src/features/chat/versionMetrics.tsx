// A reply's generation time and tokens in its header (parity finding 5; the
// `message.header-details` slot): elapsed seconds and output tokens, summed over the
// requests behind its text (retries, and the versions it continued), from the usage ledger
// (`GetVersionMetrics`). Its tooltip, and the panel a click opens, give time to first token,
// reasoning time, tokens per second and the last request apart. Unknown figures say so.
import type { PathEntry, VersionId } from "@rp/shared/chat.ts"
import { MAX_METRICS_VERSIONS, type VersionMetrics } from "@rp/shared/inspectorApi.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Popover } from "../../ui/Popover.tsx"
import { messageHeaderDetails } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"

/** One read per frame for the messages that asked; again when a version's status changes. */
class MetricsLoader {
  private readonly loaded = new Map<VersionId, { readonly key: string; readonly metrics: VersionMetrics | null }>()
  private readonly wanted = new Map<VersionId, string>()
  private readonly listeners = new Set<() => void>()
  private scheduled = false
  private readonly session: ChatSession
  constructor(session: ChatSession) {
    this.session = session
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  /** Undefined until read for this key; null when the version has none. */
  peek(id: VersionId, key: string) {
    const entry = this.loaded.get(id)
    return entry?.key === key ? entry.metrics : undefined
  }
  want(id: VersionId, key: string) {
    if (this.loaded.get(id)?.key === key || this.wanted.get(id) === key) return
    this.wanted.set(id, key)
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => void this.read())
  }
  /**
   * The version can finish a moment before its ledger row closes: a read that still found
   * the request running is read again, a few times, a second apart.
   */
  private readonly rereads = new Map<VersionId, number>()
  reread(id: VersionId, key: string) {
    const n = this.rereads.get(id) ?? 0
    if (n >= 5) return
    this.rereads.set(id, n + 1)
    setTimeout(() => {
      if (this.loaded.get(id)?.key !== key) return
      this.loaded.delete(id)
      this.want(id, key)
    }, 1000)
  }
  private async read() {
    this.scheduled = false
    const batch = [...this.wanted].slice(0, MAX_METRICS_VERSIONS)
    for (const [id] of batch) this.wanted.delete(id)
    if (this.wanted.size > 0) {
      this.scheduled = true
      queueMicrotask(() => void this.read())
    }
    const outcome = await this.session.call((client) =>
      client("GetVersionMetrics", { versionIds: batch.map(([id]) => id) })
    )
    // A failed read leaves them unread; the next status change asks again.
    if (!outcome.ok) return
    const found = new Map(outcome.value.map((metrics) => [metrics.versionId, metrics]))
    for (const [id, key] of batch) this.loaded.set(id, { key, metrics: found.get(id) ?? null })
    for (const listener of this.listeners) listener()
  }
}

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
    ended > 0 && m.outputUnknown === ended
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
  const output =
    m.outputUnknown > 0
      ? `${count(m.output)} counted; ${m.outputUnknown === 1 ? "1 request" : `${m.outputUnknown} requests`} reported none`
      : `${count(m.output)}${m.estimated ? " (estimated: the provider reported no count)" : ""}`
  const rows: Array<[string, string]> = [
    ["Generation time", m.elapsedMs === null ? "unknown" : seconds(m.elapsedMs)],
    ["Time to first token", firstToken],
    ["Output tokens", output],
    ["Speed", rate]
  ]
  if (hasReasoning) {
    rows.push(["Reasoning tokens", m.reasoning === null ? "unknown" : count(m.reasoning)])
    rows.push(["Reasoning time", "not recorded"])
  }
  if (m.requests > 1) {
    rows.push(["Requests", `${m.requests} (retries and the versions it continued)`])
    rows.push([
      "Last request",
      `${last.endedAt === null ? "running" : seconds(last.endedAt - last.startedAt)}, ${
        last.output === null ? "tokens unknown" : `${count(last.output)} tokens`
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
  const stale = wanted && metrics?.running === true
  useEffect(() => {
    if (stale) loader.reread(version.id, key)
  }, [loader, stale, version.id, key])
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
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
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
