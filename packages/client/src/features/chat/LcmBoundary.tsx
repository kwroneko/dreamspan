// Where verbatim history starts (DESIGN §8.1): a divider in the message list, always there
// with LCM on, saying what stands in for the messages above it. It opens the summaries.
import type { LcmState } from "@rp/shared/lcm.ts"
import { Badge } from "../../ui/Surface.tsx"
import { boundaryText, countsOf, jobText } from "./lcm.ts"

export function LcmBoundary({ lcm, onOpen }: { lcm: LcmState; onOpen: () => void }) {
  const counts = countsOf(lcm)
  const running = counts.running[0]
  return (
    <button
      type="button"
      data-testid="lcm-boundary"
      aria-haspopup="dialog"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md px-2 py-2 text-sm text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span aria-hidden="true" className="hidden h-px min-w-6 flex-1 bg-border sm:block" />
      <span className="font-medium">{boundaryText(lcm)}</span>
      {counts.stale > 0 && <Badge tone="warning">{counts.stale} stale</Badge>}
      {counts.failed > 0 && <Badge tone="danger">{counts.failed} failed</Badge>}
      {counts.rerun > 0 && <Badge tone="accent">{counts.rerun} to redo</Badge>}
      {running && <Badge tone="accent">{jobText(running)}</Badge>}
      {!running && counts.queued > 0 && <Badge tone="accent">{counts.queued} queued</Badge>}
      <span aria-hidden="true" className="hidden h-px min-w-6 flex-1 bg-border sm:block" />
    </button>
  )
}
