// Layout and status pieces with no behavior of their own: cards, badges, callouts and
// empty states.
import type { ReactNode } from "react"

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-border bg-surface p-4 sm:p-5 ${className}`}>{children}</section>
}

/** A card's heading row: title and description, with actions to the right (below on phones). */
export function CardHeader({
  title,
  description,
  actions,
  level = 2
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  level?: 2 | 3
}) {
  const Heading = level === 2 ? "h2" : "h3"
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <Heading className="text-base font-semibold">{title}</Heading>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger"

const badgeTones: Record<Tone, string> = {
  neutral: "border-border text-muted",
  accent: "border-accent/40 text-accent",
  success: "border-success/40 text-success",
  warning: "border-warning/50 text-warning",
  danger: "border-danger/40 text-danger"
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap ${badgeTones[tone]}`}
    >
      {children}
    </span>
  )
}

const alertTones: Record<Exclude<Tone, "accent">, string> = {
  neutral: "border-border bg-surface-raised",
  success: "border-success/40 bg-success/5",
  warning: "border-warning/50 bg-warning/5",
  danger: "border-danger/40 bg-danger/5"
}

const alertTitleTones: Record<Exclude<Tone, "accent">, string> = {
  neutral: "text-text",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger"
}

/**
 * A callout. Danger alerts are announced at once (role="alert"); the others politely.
 * Mount it with its content, so screen readers announce the change.
 */
export function Alert({
  tone = "neutral",
  title,
  children,
  actions
}: {
  tone?: Exclude<Tone, "accent">
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-start sm:justify-between ${alertTones[tone]}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {title && <p className={`font-medium ${alertTitleTones[tone]}`}>{title}</p>}
        {children && <div className="text-text [overflow-wrap:anywhere]">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="flex flex-col items-center gap-3 text-sm text-muted">{children}</div>}
    </div>
  )
}
