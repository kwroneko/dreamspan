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

/** A loading placeholder for a region, announced politely. */
export function Loading({ label = "Loading…" }: { label?: string | undefined }) {
  return (
    <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted">
      <Spinner />
      {label}
    </p>
  )
}
