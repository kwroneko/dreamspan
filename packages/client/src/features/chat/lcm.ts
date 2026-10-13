// What the summary screens share (DESIGN §8, ARCHITECTURE §16): how a range, a size and a
// state are said, the boundary's text, and whether this browser draws the coverage rail.
import type { LcmJob, LcmState, LcmSummary } from "@rp/shared/lcm.ts"
import { useSyncExternalStore } from "react"

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
      ? "imported from SillyTavern"
      : origin === "changeset"
        ? "changed by an agent"
        : "written by the model"

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

export const countsOf = (lcm: LcmState): BoundaryCounts => ({
  stale: lcm.layer.filter((s) => healthOf(s) === "stale").length,
  failed: new Set([
    ...lcm.failed.map((s) => `${s.level}:${s.from}:${s.to}`),
    ...lcm.jobs.filter((j) => j.status === "failed").map((j) => `${j.level}:${j.from}:${j.to}`)
  ]).size,
  running: lcm.jobs.filter((j) => j.status === "processing"),
  queued: lcm.jobs.filter((j) => j.status === "pending").length,
  rerun:
    lcm.layer.filter((s) => s.rerun).length +
    lcm.jobs.filter((j) => j.rerun).length +
    lcm.failed.filter((s) => s.rerun).length
})

// --- Whether the coverage rail is drawn: a choice of this browser, kept in its storage.

const RAIL_KEY = "rp.lcmRail"
const railListeners = new Set<() => void>()

const readRail = () => {
  try {
    return localStorage.getItem(RAIL_KEY) === "1"
  } catch {
    return false
  }
}
let railValue = readRail()

export const setRail = (on: boolean) => {
  railValue = on
  try {
    localStorage.setItem(RAIL_KEY, on ? "1" : "0")
  } catch {
    // Storage is blocked: the choice lasts until the page is closed.
  }
  for (const listener of railListeners) listener()
}

const subscribeRail = (listener: () => void) => {
  railListeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== RAIL_KEY) return
    railValue = readRail()
    listener()
  }
  addEventListener("storage", onStorage)
  return () => {
    railListeners.delete(listener)
    removeEventListener("storage", onStorage)
  }
}

export const useRail = () =>
  useSyncExternalStore(
    subscribeRail,
    () => railValue,
    () => false
  )
