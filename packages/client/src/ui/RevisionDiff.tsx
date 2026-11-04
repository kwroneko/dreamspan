import { Tooltip } from "./Tooltip.tsx"
import { lazy, Suspense, useState } from "react"

const Diff = lazy(() => import("./RevisionDiffView.tsx"))

/** Long histories mount only the comparisons the reader opens. */
export function RevisionComparison({ label, before, after }: { label: string; before: string; after: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="min-w-0 rounded-md border border-border p-2"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <Tooltip label="Shows the added and removed text for this revision.">
        <summary className="cursor-pointer text-sm">{label}</summary>
      </Tooltip>
      {open && (
        <div className="mt-2">
          <RevisionDiff before={before} after={after} />
        </div>
      )}
    </details>
  )
}

/** Full, read-only text comparison, side by side on desktop; unified on phones unless explicitly kept side by side. */
export function RevisionDiff({
  before,
  after,
  sideBySide = false,
  beforeLabel = "Before",
  afterLabel = "After",
  unifiedLabel
}: {
  before: string
  after: string
  sideBySide?: boolean
  beforeLabel?: string
  afterLabel?: string
  unifiedLabel?: string | undefined
}) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted">
          Loading diff…
        </p>
      }
    >
      <Diff
        before={before}
        after={after}
        sideBySide={sideBySide}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        unifiedLabel={unifiedLabel}
      />
    </Suspense>
  )
}
