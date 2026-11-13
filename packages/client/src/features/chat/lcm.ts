// What the summary screens share (DESIGN §8, ARCHITECTURE §16): how a range, a size and a
// state are said and the boundary's text.
import type { LcmJob, LcmState, LcmSummary } from "@rp/shared/lcm.ts"

/** Message numbers are one-based and count the path's messages, as the context view does. */
export const rangeText = (from: number, to: number) => (from === to ? `Message ${from}` : `Messages ${from}–${to}`)

export const tokensText = (tokens: number) =>
  tokens >= 10_000
    ? `~${Math.round(tokens / 1000)}k tokens`
    : tokens >= 1000
      ? `~${(tokens / 1000).toFixed(1)}k tokens`
      : `~${tokens} tokens`

/** Money as an estimate gives it: cents or less for a short job, so small amounts keep their digits. */
export const moneyText = (amount: number, currency: string) => {
  const digits = amount >= 10 ? 0 : amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(amount)
  } catch {
    // A currency code the browser doesn't know is only a label (PROVIDERS §9.3).
    return `${amount.toFixed(digits)} ${currency}`
  }
}

export const durationText = (seconds: number) =>
  seconds < 60
    ? "under a minute"
    : seconds < 3600
      ? `about ${Math.round(seconds / 60)} minutes`
      : `about ${(seconds / 3600).toFixed(1)} hours`

/** A count of tokens, rounded as an estimate is. */
export const countText = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 10_000
      ? `${Math.round(tokens / 1000)}k`
      : tokens >= 1000
        ? `${(tokens / 1000).toFixed(1)}k`
        : String(tokens)

export type SummaryHealth = "failed" | "stale" | "fresh" | "resolved"

/** A summary is stale when what it covers changed since; one that failed has no text. */
export const healthOf = (summary: Pick<LcmSummary, "status" | "fresh" | "resolved">): SummaryHealth =>
  summary.status === "failed" ? (summary.resolved ? "resolved" : "failed") : summary.fresh ? "fresh" : "stale"

export const originText = (origin: LcmSummary["origin"]) =>
  origin === "user"
    ? "edited by you"
    : origin === "imported"
      ? "imported with the chat"
      : origin === "changeset"
        ? "changed by an agent"
        : "written by the model"

/** The kinds of failure a job records (`JobError.class`), said plainly. */
const failureClasses: Record<string, string> = {
  unusable: "The connection can't be used",
  budget_held: "Held by the spending limit",
  auth: "The provider refused the key",
  rate_limited: "The provider's rate limit was reached",
  overloaded: "The provider was busy",
  context_overflow: "Too long for the model",
  length_cutoff: "Cut off by the reply length",
  refused: "The model refused",
  refusal: "The model refused",
  bad_request: "The provider refused the request",
  network: "The provider couldn't be reached",
  no_response: "The provider sent nothing back",
  aborted: "Stopped"
}

/**
 * Why a summary or a job failed, in words: the stored error is the job's JSON
 * (`{ class, message }`), whose message may carry the provider's own JSON body after its
 * status. Anything else is shown as it is.
 */
export const failureText = (error: string): string => {
  let cls: string | null = null
  let message = error
  try {
    const parsed = JSON.parse(error) as unknown
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      message = String((parsed as { message: unknown }).message)
      cls = "class" in parsed ? String((parsed as { class: unknown }).class) : null
    }
  } catch {
    // Not JSON: the text as it was stored.
  }
  // "500: {"message":"…"}" or "500: {"error":{"message":"…"}}": the provider's own words.
  const body = message.match(/^(?:[A-Za-z]+Error: )?(\d{3}): (\{.*\})$/s)
  let status: string | null = null
  if (body) {
    try {
      const inner = JSON.parse(body[2]!) as { message?: unknown; error?: { message?: unknown } | string }
      const said =
        typeof inner.message === "string"
          ? inner.message
          : typeof inner.error === "string"
            ? inner.error
            : typeof inner.error?.message === "string"
              ? inner.error.message
              : null
      if (said !== null) {
        message = said
        status = body[1]!
      }
    } catch {
      // Not JSON after all.
    }
  }
  const lead = cls === null ? null : (failureClasses[cls] ?? null)
  const detail = status === null ? message : `${message} (HTTP ${status})`
  return lead === null ? detail : `${lead}: ${detail}`
}

/** The work still to do or given up on, for the divider and the panel. */
export const jobText = (job: LcmJob) =>
  job.status === "processing"
    ? `Summarizing ${rangeText(job.from, job.to).toLowerCase()}…`
    : job.status === "pending"
      ? `${rangeText(job.from, job.to)} queued`
      : `${rangeText(job.from, job.to)} could not be summarized`

/** The divider's line: what stands in for the messages above it. */
export const boundaryText = (lcm: LcmState) => {
  const n = lcm.layer.length
  if (n === 0) return "Older messages: none summarized yet"
  const tokens = lcm.layer.reduce((sum, s) => sum + s.tokens, 0)
  return `Older messages: ${n === 1 ? "1 summary" : `${n} summaries`}, ${tokensText(tokens)}`
}

export interface BoundaryCounts {
  readonly stale: number
  readonly failed: number
  readonly running: ReadonlyArray<LcmJob>
  readonly queued: number
  readonly rerun: number
}

/**
 * A failed redo of a summary the user edited: the user's text, over the same level and range,
 * stays in use, so nothing the model reads is missing (owner, 2026-11-02). It's listed in the
 * Summaries tab under Failed, with Retry, and isn't counted on the divider.
 */
export const userTextKept = (lcm: LcmState, range: Work) =>
  lcm.layer.some(
    (s) =>
      s.origin === "user" &&
      s.level === range.level &&
      s.from === range.from &&
      s.to === range.to &&
      sameAudience(s, range)
  )

type Work = Pick<LcmSummary, "level" | "from" | "to" | "audience">

/** Whose a summary or a job is, as one key: "" for the shared ones, else its character's identities. */
const audienceKey = (work: Pick<LcmSummary, "audience">) => [...(work.audience ?? [])].sort().join(",")

/**
 * Two pieces of work for the same reader. With separate contexts a shared summary and a
 * character's own can cover the same messages at the same level, so a range alone never says two
 * are the same: rows match by id, and work without a common id (a failed job and the failed
 * summary it left) by its range and whose it is.
 */
export const sameAudience = (a: Pick<LcmSummary, "audience">, b: Pick<LcmSummary, "audience">) =>
  audienceKey(a) === audienceKey(b)

/** The same work: level, range and whose it is. */
export const sameWork = (a: Work, b: Work) =>
  a.level === b.level && a.from === b.from && a.to === b.to && sameAudience(a, b)

export const countsOf = (lcm: LcmState): BoundaryCounts => ({
  stale: lcm.layer.filter((s) => healthOf(s) === "stale").length,
  failed: new Set(
    [...lcm.failed, ...lcm.jobs.filter((j) => j.status === "failed")]
      .filter((range) => !userTextKept(lcm, range))
      .map((range) => `${range.level}:${range.from}:${range.to}:${audienceKey(range)}`)
  ).size,
  running: lcm.jobs.filter((j) => j.status === "processing"),
  queued: lcm.jobs.filter((j) => j.status === "pending").length,
  rerun:
    lcm.layer.filter((s) => s.rerun).length +
    lcm.jobs.filter((j) => j.rerun).length +
    lcm.failed.filter((s) => s.rerun).length
})
