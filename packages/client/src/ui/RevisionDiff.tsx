import { lazy, Suspense } from "react"

const Diff = lazy(() => import("./RevisionDiffView.tsx"))

/** Full, read-only text comparison, side by side on desktop; unified on phones unless explicitly kept side by side. */
export function RevisionDiff({
  before,
  after,
  sideBySide = false,
  beforeLabel = "Before",
  afterLabel = "After"
}: {
  before: string
  after: string
  sideBySide?: boolean
  beforeLabel?: string
  afterLabel?: string
}) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted">
          Loading diff…
        </p>
      }
    >
      <Diff before={before} after={after} sideBySide={sideBySide} beforeLabel={beforeLabel} afterLabel={afterLabel} />
    </Suspense>
  )
}
