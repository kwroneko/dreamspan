import { lazy, Suspense } from "react"

const Diff = lazy(() => import("./RevisionDiffView.tsx"))

/** Full, read-only text comparison, side by side on desktop and unified on phones. */
export function RevisionDiff({ before, after }: { before: string; after: string }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted">
          Loading diff…
        </p>
      }
    >
      <Diff before={before} after={after} />
    </Suspense>
  )
}
