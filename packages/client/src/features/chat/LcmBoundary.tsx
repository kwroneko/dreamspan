// Where verbatim history starts (DESIGN §8.1): a divider in the message list, always there
// with LCM on, saying what stands in for the messages above it. It opens the summaries.
import { SummaryTabs } from "./SummaryTabs.tsx"
import type { LcmState } from "@rp/shared/lcm.ts"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { boundaryText, countsOf, jobText } from "./lcm.ts"

export function LcmBoundary({ lcm, onOpen }: { lcm: LcmState; onOpen: () => void }) {
  const counts = countsOf(lcm)
  const running = counts.running[0]
  const states = [
    counts.stale > 0 && `${counts.stale} stale: their messages changed since they were written`,
    counts.failed > 0 && `${counts.failed} failed: those messages are sent as they are while they fit`,
    counts.rerun > 0 && `${counts.rerun} to be written again with your next reply`,
    running && `${jobText(running)}`,
    !running && counts.queued > 0 && `${counts.queued} queued`
  ].filter((state): state is string => typeof state === "string")
  const hint = `${
    lcm.layer.length === 0
      ? "Nothing stands in for older messages yet."
      : "Summaries stand in for the messages above in what the model is sent."
  }${states.length ? ` ${states.join("; ")}.` : ""} Opens them in the Summaries tab.`
  const button = (
    <Tooltip label={hint}>
      <button
        type="button"
        data-testid="lcm-boundary"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-sm text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="font-medium">{boundaryText(lcm)}</span>
        {counts.stale > 0 && <Badge tone="warning">{counts.stale} stale</Badge>}
        {counts.failed > 0 && <Badge tone="danger">{counts.failed} failed</Badge>}
        {counts.rerun > 0 && <Badge tone="accent">{counts.rerun} to redo</Badge>}
        {running && <Badge tone="accent">{jobText(running)}</Badge>}
        {!running && counts.queued > 0 && <Badge tone="accent">{counts.queued} queued</Badge>}
      </button>
    </Tooltip>
  )
  // With summaries, the boundary is the line the Messages and Summaries tabs hang from, what
  // stands in for the messages above under them; without, a plain divider.
  return lcm.layer.length > 0 ? (
    <div className="flex flex-col items-center gap-1 py-2">
      <SummaryTabs at="boundary" />
      {button}
    </div>
  ) : (
    <div className="flex w-full items-center gap-3 py-2">
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
      {button}
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
    </div>
  )
}
