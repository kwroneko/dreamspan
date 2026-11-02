// A reply's generation time and tokens under its portrait, as ST shows them ("12.4s",
// "384t"; parity finding 5, msgmeta): two message details (messageDetails.tsx). For a reply
// generated here, elapsed seconds and output tokens summed over the requests behind its text
// (retries, and the versions it continued), from the usage ledger (`GetVersionMetrics`); for
// an imported one, what SillyTavern recorded (`Version.recorded`: its own token count of the
// text and reasoning). Each one's tooltip, and the panel a click opens, give time to first
// token, reasoning time, tokens per second and the last request apart. Unknown figures say so;
// one not recorded at all isn't shown.
import type { RecordedGeneration } from "@rp/shared/chat.ts"
import type { VersionMetrics } from "@rp/shared/inspectorApi.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Popover } from "../../ui/Popover.tsx"
import { formatFullTime, type MessageDetailProps, messageDetails } from "./messageDetails.tsx"
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

/** The short forms under the portrait, as ST writes them: "12.4s", "384t". */
const shortTime = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const shortTokens = (n: number, estimated = false, partial = false) =>
  `${estimated ? "~" : ""}${n}${partial ? "+" : ""}t`

/** One version's figures as the details show them: the short forms (null: unknown) and the full rows. */
export interface Figures {
  readonly time: string | null
  readonly tokens: string | null
  /** "12.3 s · 340 tokens", the panel trigger's name. */
  readonly summary: string
  readonly rows: ReadonlyArray<readonly [string, string]>
}

const ownFigures = (m: VersionMetrics, reasoning: boolean): Figures => {
  const ended = m.requests - (m.running ? 1 : 0)
  const counted = ended > 0 && m.outputUnknown < ended
  return {
    time: m.elapsedMs === null ? null : shortTime(m.elapsedMs),
    tokens: counted ? shortTokens(m.output, m.estimated, m.outputUnknown > 0) : null,
    summary: metricsSummary(m),
    rows: metricsDetails(m, reasoning)
  }
}

/** What SillyTavern recorded for an imported version, in the same rows (ST's own timer tooltip's). */
export const recordedFigures = (r: RecordedGeneration): Figures => {
  const span = r.startedAt !== undefined && r.finishedAt !== undefined ? r.finishedAt - r.startedAt : null
  const rows: Array<[string, string]> = []
  if (span !== null) {
    rows.push(["Started", formatFullTime(r.startedAt!)])
    rows.push(["Finished", formatFullTime(r.finishedAt!)])
    rows.push(["Generation time", seconds(span)])
  }
  if (r.firstTokenMs !== undefined) rows.push(["Time to first token", seconds(r.firstTokenMs)])
  if (r.reasoningMs !== undefined) rows.push(["Reasoning time", seconds(r.reasoningMs)])
  if (r.tokens !== undefined) {
    rows.push(["Tokens", `${count(r.tokens)} (as imported: the text and its reasoning)`])
    if (span !== null && span > 0) rows.push(["Speed", `${(r.tokens / (span / 1000)).toFixed(1)} tokens/s`])
  }
  rows.push(["Recorded by", "The imported chat"])
  return {
    time: span === null ? null : shortTime(span),
    tokens: r.tokens === undefined ? null : shortTokens(r.tokens),
    summary: `${span === null ? "time unknown" : seconds(span)} · ${
      r.tokens === undefined ? "tokens unknown" : `${count(r.tokens)} tokens`
    }`,
    rows
  }
}

/** A version's figures: what its import recorded, else its requests here once it's finished; null for none. */
function useFigures({ entry, session, generating }: MessageDetailProps): Figures | null {
  const { version } = entry
  const loader = loaderOf(session)
  const key = version.status
  const own = version.recorded === undefined && version.writer === "model" && !generating
  const metrics = useSyncExternalStore(loader.subscribe, () => (own ? loader.peek(version.id, key) : undefined))
  useEffect(() => {
    if (own) loader.want(version.id, key)
  }, [loader, own, version.id, key])
  if (version.recorded !== undefined) return recordedFigures(version.recorded)
  return own && metrics ? ownFigures(metrics, Boolean(version.reasoning)) : null
}

function Figure({ which, ...props }: MessageDetailProps & { which: "time" | "tokens" }) {
  const figures = useFigures(props)
  const [open, setOpen] = useState(false)
  const shown = figures === null ? null : which === "time" ? figures.time : figures.tokens
  if (figures === null || shown === null) return null
  const rows = figures.rows
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="Generation"
      triggerLabel={which === "time" ? `Generation: ${figures.summary}` : `Tokens: ${figures.summary}`}
      triggerClassName="rounded-sm tabular-nums outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      trigger={shown}
      align="start"
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

function GenerationTime(props: MessageDetailProps) {
  return <Figure which="time" {...props} />
}
function TokenCount(props: MessageDetailProps) {
  return <Figure which="tokens" {...props} />
}

export const registerVersionMetrics = () => [
  messageDetails.register({
    id: "message.timer",
    place: "portrait",
    order: 20,
    label: "Generation time",
    description: "How long the model took to write a reply. Click it for time to first token and speed.",
    component: GenerationTime
  }),
  messageDetails.register({
    id: "message.tokens",
    place: "portrait",
    order: 30,
    label: "Token count",
    description:
      "How many tokens a message came to: the provider's count for replies written here, the imported count for imported messages.",
    component: TokenCount
  })
]
