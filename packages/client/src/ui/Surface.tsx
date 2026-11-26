import { CenterHeaderContent } from "./CenterHeader.tsx"
// Layout and status pieces with no behavior of their own: cards, badges, callouts and
// empty states, and sections opened on demand.
import { type ReactNode, useState } from "react"
import { AboutHint, LabelWithHelp } from "./AboutHint.tsx"
import { TitledContainer, useRepeatsTitle } from "./titledContainer.tsx"
import { Tooltip } from "./Tooltip.tsx"

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-border bg-surface p-4 sm:p-5 ${className}`}>{children}</section>
}

/**
 * A card's heading row: title, with actions to the right (below on phones, unless `inline`:
 * for one small icon button that fits beside the title anywhere). `description` is a standing
 * line of state (a count, a progress line), never an explanation; `about` is an explanation
 * the user needs to choose correctly, in a "?" beside the title (DESIGN §10.1). It needs a
 * string title, for its name.
 */
export function CardHeader({
  title,
  description,
  about,
  actions,
  inline = false,
  center = false
}: {
  title: ReactNode
  description?: ReactNode
  about?: ReactNode
  actions?: ReactNode
  inline?: boolean
  center?: boolean
}) {
  if (center)
    return (
      <>
        <CenterHeaderContent>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
            {about && <AboutHint heading={typeof title === "string" ? title : "this page"}>{about}</AboutHint>}
          </div>
        </CenterHeaderContent>
        {actions && <div className="mb-4 flex flex-wrap gap-2">{actions}</div>}
        {description && <p className="mb-4 text-sm text-muted">{description}</p>}
      </>
    )
  return (
    <div
      className={`mb-4 flex gap-3 ${inline ? "flex-row items-start justify-between" : "flex-col sm:flex-row sm:flex-wrap sm:items-start sm:justify-between"}`}
    >
      {/* The title keeps room for itself (10rem at least): when the actions don't fit beside it,
          they go to the next line rather than squeeze it ("API key" wrapped under its buttons). */}
      <div className={`flex min-w-0 flex-col gap-1 ${inline ? "" : "sm:shrink-0 sm:grow sm:basis-40"}`}>
        {about ? (
          <LabelWithHelp
            help={<AboutHint heading={typeof title === "string" ? title : "this section"}>{about}</AboutHint>}
          >
            <h2 className="inline text-base font-semibold">{title}</h2>
          </LabelWithHelp>
        ) : (
          <h2 className="text-base font-semibold">{title}</h2>
        )}
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className={`flex min-w-0 flex-wrap gap-2 ${inline ? "shrink-0" : ""}`}>{actions}</div>}
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

/** `sm`: one text-xs line tall, for a row's secondary line, which it then doesn't make taller. */
export function Badge({
  tone = "neutral",
  size = "md",
  wrap = false,
  children
}: {
  tone?: Tone
  size?: "md" | "sm"
  wrap?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border text-xs font-medium ${wrap ? "min-h-5 max-w-full px-2 [overflow-wrap:anywhere]" : size === "sm" ? "h-4 px-1.5 leading-none whitespace-nowrap" : "h-5 px-2 whitespace-nowrap"} ${badgeTones[tone]}`}
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
      className={`flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:flex-wrap sm:items-start sm:justify-between ${alertTones[tone]}`}
    >
      <div className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere] sm:basis-60 sm:grow">
        {title && <p className={`font-medium ${alertTitleTones[tone]}`}>{title}</p>}
        {children && <div className="text-text [overflow-wrap:anywhere]">{children}</div>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap gap-2">{actions}</div>}
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

/**
 * A section shown by its title and opened on demand (a native `<details>`): for what most people
 * never need, kept out of the way but in plain sight.
 */
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  className = "",
  lazy = false,
  hint,
  open,
  onOpenChange
}: {
  title: ReactNode
  children: ReactNode
  hint?: string
  defaultOpen?: boolean
  /** Controlled: whether it's open, kept by the caller (a URL place, so a reload opens it again). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  /** Mount the contents only once opened: for heavy contents (code editors) most visits never open. */
  lazy?: boolean
}) {
  const [opened, setOpened] = useState(open ?? defaultOpen)
  const [expanded, setExpanded] = useState(open ?? defaultOpen)
  // A section under a title saying the same: its toggle stays, the repeat is reported (data-title-repeated).
  const repeats = useRepeatsTitle(title, false, "The section's title")
  const summary = (
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-sm font-medium text-muted outline-none select-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
      {title}
    </summary>
  )
  return (
    <details
      open={open ?? defaultOpen}
      {...(repeats ? { "data-title-repeated": "" } : {})}
      className={`group ${className}`}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open)
        if (lazy && event.currentTarget.open) setOpened(true)
        if (open !== undefined && open !== event.currentTarget.open) onOpenChange?.(event.currentTarget.open)
      }}
    >
      <Tooltip
        label={
          hint ??
          `Click to ${(open ?? expanded) ? "collapse" : "expand"} ${typeof title === "string" ? title.toLowerCase() : "this section"}.`
        }
      >
        {summary}
      </Tooltip>
      <div className="flex flex-col gap-4 pt-3 pb-2 pl-5">
        <TitledContainer title={title}>{!lazy || opened || open ? children : null}</TitledContainer>
      </div>
    </details>
  )
}
