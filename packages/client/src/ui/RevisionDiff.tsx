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
      <summary className="cursor-pointer text-sm">{label}</summary>
      {open && (
        <div className="mt-2">
          <RevisionDiff before={before} after={after} />
        </div>
      )}
    </details>
  )
}

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
