// The coverage rail (DESIGN §8.1): a thin strip beside the messages with a bar for every
// summary over them, level by level outward from the messages. A bar that is hatched is
// stale, one in the danger color failed, a pulsing one is being written. A click opens the
// summary. It reads only the window of the path that is loaded (GetLcmCoverage).
import { positionOf } from "./position.ts"
import type { PathEntry } from "@rp/shared/chat.ts"
import type { LcmState, LcmSummary } from "@rp/shared/lcm.ts"
import { useEffect, useState } from "react"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { healthOf, jobText, rangeText } from "./lcm.ts"
import type { ChatSession } from "./session.ts"

/** Width of one level's lane, in pixels. */
export const LANE_PX = 10

/** The first index whose position is at least `depth`, in a list ordered by position. */
const lowerBound = (entries: ReadonlyArray<PathEntry>, depth: number) => {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (positionOf(entries[mid]!) < depth) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The summaries over the loaded window, kept while the next read is in flight. */
export function useCoverage(
  session: ChatSession,
  entries: ReadonlyArray<PathEntry>,
  lcm: LcmState | null,
  version: number,
  on: boolean
) {
  const [coverage, setCoverage] = useState<{ leaf: string; rows: ReadonlyArray<LcmSummary> } | null>(null)
  const first = entries[0] && positionOf(entries[0])
  const last = entries.at(-1) && positionOf(entries.at(-1)!)
  const leaf = lcm?.leafSlotId
  useEffect(() => {
    if (!on || first === undefined || last === undefined || leaf === undefined) return
    let live = true
    const timer = setTimeout(() => {
      void session.coverage(first, last).then((result) => {
        if (live && result) setCoverage({ leaf, rows: result.summaries })
      })
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [session, on, first, last, leaf, version])
  return coverage !== null && coverage.leaf === leaf ? coverage.rows : []
}

interface Bar {
  readonly key: string
  readonly level: number
  readonly top: number
  readonly height: number
  readonly className: string
  readonly label: string
  readonly open: string | null
}

const barClass = (summary: LcmSummary, inUse: boolean) => {
  switch (healthOf(summary)) {
    case "failed":
      return "bg-danger"
    case "stale":
      return `rail-stale ${inUse ? "" : "opacity-60"}`
    default:
      return inUse ? "bg-accent" : "bg-accent/35"
  }
}

export function CoverageRail({
  entries,
  rows,
  lcm,
  position,
  onOpen
}: {
  entries: ReadonlyArray<PathEntry>
  rows: ReadonlyArray<LcmSummary>
  lcm: LcmState
  /** Where the row at this index of `entries` is, in the list's own coordinates. */
  position: (index: number) => { readonly start: number; readonly end: number } | null
  onOpen: (summaryId: string | null) => void
}) {
  const inUse = new Set(lcm.layer.map((s) => s.id))
  const bars: Array<Bar> = []
  const place = (from: number, to: number) => {
    const lo = lowerBound(entries, from - 1)
    const hi = lowerBound(entries, to) - 1
    if (lo > hi) return null
    const a = position(lo)
    const b = position(hi)
    return a && b ? { top: a.start, height: Math.max(4, b.end - a.start) } : null
  }
  for (const summary of rows) {
    const at = place(summary.from, summary.to)
    if (!at) continue
    const health = healthOf(summary)
    bars.push({
      key: summary.id,
      level: summary.level,
      ...at,
      className: barClass(summary, inUse.has(summary.id)),
      label: `Level ${summary.level}, ${rangeText(summary.from, summary.to).toLowerCase()}${health === "fresh" ? "" : `, ${health}`}${inUse.has(summary.id) ? ", sent to the model" : ", condensed into a higher level"}`,
      open: summary.id
    })
  }
  for (const job of lcm.jobs) {
    const at = place(job.from, job.to)
    if (!at) continue
    bars.push({
      key: job.id,
      level: job.level,
      ...at,
      className:
        job.status === "failed"
          ? "bg-danger"
          : job.status === "processing"
            ? "animate-pulse bg-accent/60 motion-reduce:animate-none"
            : "border border-dashed border-accent",
      label: `Level ${job.level}, ${jobText(job).toLowerCase()}`,
      open: null
    })
  }
  const levels = Math.max(1, ...bars.map((b) => b.level))
  return (
    <div
      data-testid="coverage-rail"
      role="group"
      aria-label="Summary coverage"
      className="pointer-events-none absolute top-0 left-0"
      style={{ width: levels * LANE_PX, height: "100%" }}
    >
      {bars.map((bar) => (
        <Tooltip key={bar.key} side="right" followCursor label={`${bar.label}. Click to open it in the Summaries tab.`}>
          <button
            type="button"
            data-level={bar.level}
            aria-label={`${bar.label}. Open the summaries.`}
            onClick={() => onOpen(bar.open)}
            className="pointer-events-auto absolute rounded-full p-0 outline-none focus-visible:ring-2 focus-visible:ring-focus"
            style={{ top: bar.top, height: bar.height, left: (bar.level - 1) * LANE_PX, width: LANE_PX - 3 }}
          >
            <span className={`block size-full rounded-full ${bar.className}`} />
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
