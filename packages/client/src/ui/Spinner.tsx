import { useEffect, useState } from "react"
import { Button } from "./Button.tsx"
import { Alert } from "./Surface.tsx"

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`size-4 shrink-0 animate-spin motion-reduce:animate-none ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * A quiet bar where a line of text will be once it's read. Give it the line's own box (a
 * `min-h-*` wrapper or the line's height) so nothing moves when the text replaces it.
 */
export function PlaceholderBar({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`block h-2.5 rounded-sm bg-border ${className}`} />
}

/**
 * A list that is still filling in: "Loading branches… 120 of 600", announced politely. Shown
 * only while `ready < total`, on a line of its own that the caller keeps in place.
 */
export function LoadingProgress({
  noun,
  ready,
  total,
  className = ""
}: {
  noun: string
  ready: number
  total: number
  className?: string
}) {
  if (ready >= total) return null
  return (
    <span role="status" className={`flex min-w-0 items-center gap-1 text-xs text-muted ${className}`}>
      <Spinner className="size-3" />
      <span className="truncate tabular-nums">
        Loading {noun}… {ready.toLocaleString()} of {total.toLocaleString()}
      </span>
    </span>
  )
}

/** Loads the page again: what retries a code chunk that never arrived. */
export const reloadPage = () => window.location.reload()

/** How long a region may load before it says so and offers to ask again. */
const SLOW_LOADING_MS = 15_000

/**
 * A loading placeholder for a region, announced politely. With `onRetry`, a load that
 * takes longer than it should says so and offers to ask again, so loading never just
 * spins: the request may be waiting on a busy server or lost with a dropped connection.
 */
export function Loading({ label = "Loading…", onRetry }: { label?: string | undefined; onRetry?: () => void }) {
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retries = onRetry !== undefined
  useEffect(() => {
    if (!retries) return
    const timer = setTimeout(() => setSlow(true), SLOW_LOADING_MS)
    return () => clearTimeout(timer)
  }, [attempt, retries])
  return (
    <div className="flex flex-col gap-2 py-6">
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <Spinner />
        {label}
      </p>
      {slow && onRetry && (
        <Alert
          tone="warning"
          title="This is taking longer than it should"
          actions={
            <Button
              hint="Retries loading this view."
              variant="ghost"
              onClick={() => {
                setSlow(false)
                setAttempt((n) => n + 1)
                onRetry()
              }}
            >
              Try again
            </Button>
          }
        >
          <p>The server may be busy, or the connection dropped.</p>
        </Alert>
      )}
    </div>
  )
}

/**
 * How far something is, as a bar in the theme's colours (a native `<progress>` takes the
 * browser's own, green on Chromium). `value` of `max`.
 */
export function ProgressBar({
  value,
  max,
  label,
  className = ""
}: {
  value: number
  max: number
  label: string
  className?: string
}) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={`overflow-hidden rounded-full bg-border ${className}`}
    >
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${share * 100}%` }} />
    </div>
  )
}
