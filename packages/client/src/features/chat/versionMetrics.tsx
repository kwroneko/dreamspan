// A reply's generation time and tokens under its portrait, as ST shows them ("12.4s",
// "384t"; parity finding 5, msgmeta): two message details (messageDetails.tsx). For a reply
// generated here, elapsed seconds and output tokens summed over the requests behind its text
// (retries, and the versions it continued), from the usage ledger (`GetVersionMetrics`); for
// an imported one, what SillyTavern recorded (`Version.recorded`: its own token count of the
// text and reasoning). Each one's tooltip, and the panel a click opens, give time to first
// token, reasoning time, tokens per second and the last request apart. Unknown figures say so;
// one not recorded at all isn't shown. In the header, after the time, what the reply cost
// (msgcost1, the ledger's cost; none for an import or a user's turn), opening the same panel.
import type { RecordedGeneration } from "@dreamspan/shared/chat.ts"
import type { CostAmount, VersionMetrics } from "@dreamspan/shared/inspectorApi.ts"
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

/**
 * An amount as the header shows it: "$0.012" ("$1.23" from a dollar up), with two significant
 * digits under a cent ("$0.0041"); another currency's label after the number ("0.012 EUR").
 */
export const formatCost = ({ amount, currency }: CostAmount) => {
  const digitsOf = (a: number) =>
    a <= 0 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 3 : Math.min(12, 1 - Math.floor(Math.log10(a)))
  // Rounding can carry it into the next band ($0.00999 is "$0.010", $0.9996 is "$1.00").
  const first = digitsOf(Math.abs(amount))
  const digits = digitsOf(Number(Math.abs(amount).toFixed(first)))
  const n = (Math.abs(amount) < 10 ** -digits / 2 ? 0 : amount).toFixed(digits)
  return currency === "USD" ? `$${n}` : `${n} ${currency}`
}

/**
 * The header's cost: "$0.012", "~" first when it was priced from estimated counts, "+" after
 * when some request had no cost or was priced in another currency; null when none had one.
 */
export const shortCost = (m: VersionMetrics) => {
  const first = m.costs[0]
  if (first === undefined) return null
  return `${m.costEstimated ? "~" : ""}${formatCost(first)}${m.costUnknown > 0 || m.costs.length > 1 ? "+" : ""}`
}

const sourceName = (formula: string) =>
  formula === "reported"
    ? "the provider's charge"
    : formula === "builtin"
      ? // Costs recorded before sources were told apart: the catalog or the model list's price.
        "the model's price list"
      : formula.startsWith("builtin:")
        ? "the app's built-in prices"
        : formula === "list" || formula.startsWith("list:")
          ? "the provider's price list"
          : formula.startsWith("endpoint:")
            ? "this server's price list"
            : formula.startsWith("user:")
              ? "your cost formula"
              : formula

const requestsText = (n: number) => (n === 1 ? "1 request" : `${n} requests`)

/** The cost rows: the total and how it was priced, the provider's charge when it differs, and the input split. */
export const costDetails = (m: VersionMetrics): ReadonlyArray<[string, string]> => {
  const rows: Array<[string, string]> = []
  const ended = m.requests - (m.running ? 1 : 0)
  if (ended === 0) return rows
  if (m.costs.length === 0) rows.push(["Cost", "unknown (no price for this model)"])
  else {
    rows.push([
      "Cost",
      `${m.costs.map(formatCost).join(" + ")}${m.costEstimated ? " (estimated)" : ""}${
        m.costUnknown > 0 ? `; ${requestsText(m.costUnknown)} had none` : ""
      }`
    ])
    rows.push(["Priced by", m.costSources.map(sourceName).join(", ")])
  }
  const usd = m.costs.find((c) => c.currency === "USD")
  const same =
    m.costSources.length === 1 &&
    m.costSources[0] === "reported" &&
    m.costUnknown === 0 &&
    m.reportedRequests === ended &&
    usd !== undefined &&
    m.reportedCost !== null &&
    Math.abs(usd.amount - m.reportedCost) < 1e-9
  if (m.reportedCost !== null && !same)
    rows.push([
      "Provider charged",
      `${formatCost({ amount: m.reportedCost, currency: "USD" })}${
        m.reportedRequests < ended ? ` (${m.reportedRequests} of ${requestsText(ended)})` : ""
      }`
    ])
  const { inputUncached: uncached, cacheRead: read, cacheWrite: write, cacheWriteLong: long } = m
  if (uncached === null || read === null || write === null) rows.push(["Input tokens", "unknown"])
  else {
    const all = uncached + read + write
    rows.push([
      "Input tokens",
      `${count(all)} (${count(uncached)} uncached, ${count(read)} cache read, ${count(write)} cache write${
        long !== null && long > 0 ? `, ${count(long)} of it long-lived` : ""
      })`
    ])
    rows.push(["Cached", all === 0 ? "none" : `${Math.round((read / all) * 100)}% of input`])
  }
  return rows
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
    ["Output tokens", ended > 0 && m.outputUnknown < ended ? `${output}, reasoning included` : output],
    ["Speed", rate],
    ...costDetails(m)
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
      }${last.cost === null ? "" : `, ${formatCost(last.cost)}`}`
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
  /** The header's cost ("$0.012"); null for none, and always for an import. */
  readonly cost: string | null
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
    cost: shortCost(m),
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
    cost: null,
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

const triggerNames = { time: "Generation", tokens: "Tokens", cost: "Cost" } as const
const costClass =
  "shrink-0 overflow-hidden text-xs whitespace-nowrap text-muted max-sm:min-w-0 max-sm:shrink max-sm:basis-0 max-sm:grow-[100] max-sm:max-w-max @max-[30rem]/chat:min-w-0 @max-[30rem]/chat:shrink @max-[30rem]/chat:basis-0 @max-[30rem]/chat:grow-[100] @max-[30rem]/chat:max-w-max"
const focusRing = "rounded-sm tabular-nums outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"

function Figure({ which, ...props }: MessageDetailProps & { which: "time" | "tokens" | "cost" }) {
  const figures = useFigures(props)
  const [open, setOpen] = useState(false)
  const shown = figures === null ? null : figures[which]
  if (figures === null || shown === null) return null
  const rows = figures.rows
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="Generation"
      triggerLabel={`${triggerNames[which]}: ${which === "cost" ? `${shown} · ` : ""}${figures.summary}`}
      // In the header it keeps its width, as the time does: the model's label gives way instead.
      // Where the header wraps, it never starts a line: it takes its width from what the line
      // leaves, ahead of the model's label, so showing it can't make the header taller.
      triggerClassName={which === "cost" ? `${costClass} ${focusRing}` : focusRing}
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
function Cost(props: MessageDetailProps) {
  return <Figure which="cost" {...props} />
}

export const registerVersionMetrics = () => [
  messageDetails.register({
    id: "message.cost",
    place: "header",
    order: 15,
    label: "Cost",
    description:
      "What a reply written here cost, retries and continuations included. Click it for the input, cache and output tokens.",
    component: Cost
  }),
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
