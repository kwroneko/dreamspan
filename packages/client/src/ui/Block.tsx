// A bounded block (owner, 2026-11-01): one shape for a list of structurally alike things, a
// preset's prompts, a chat's notes and snippets. A header that's always shown (its name, a
// button that opens or closes the block, renamed in place beside it, a line under it saying the
// state of what matters, and its actions), then what it opens to: its text first, and its
// settings folded away in a section of their own. A list of blocks has Expand all and Collapse all.
import type { ComponentProps, ReactNode } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"
import { IconButton, Tooltip } from "./Tooltip.tsx"
import { rowActionInsetClass } from "./rowSpacing.ts"

/** The block: a bordered card; `dashed` for a slim row standing for something else (a marker). */
export function Block({
  dashed = false,
  className = "",
  children,
  ...props
}: ComponentProps<"section"> & { dashed?: boolean }) {
  return (
    <section
      {...props}
      className={`rounded-lg border ${
        dashed ? "border-dashed border-border bg-transparent" : "border-border bg-surface shadow-xs"
      } ${className}`}
    >
      {children}
    </section>
  )
}

/** The header's row: what leads (a handle, a switch), the name, then the actions at the end. */
export function BlockHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <header className={`flex min-w-0 items-start gap-0.5 py-1 ps-1 ${rowActionInsetClass} ${className}`}>
      {children}
    </header>
  )
}

/**
 * The name as the button that opens and closes the block, with a line under it (`detail`):
 * the state of what matters about it, shown closed too.
 */
export function BlockToggle({
  open,
  onToggle,
  label,
  name,
  detail,
  hint,
  derived = false,
  dim = false
}: {
  open: boolean
  onToggle: () => void
  /** What the block is, for the button's accessible name: "Expand <label>". */
  label: string
  /** How the name shows. */
  name: ReactNode
  detail?: ReactNode
  /** The tooltip; "Show its text" or "Hide its text" by default. */
  hint?: string
  /** The name stands in for one it hasn't (its first words): muted and italic. */
  derived?: boolean
  /** It's switched off: shown dimmer. */
  dim?: boolean
}) {
  return (
    <Tooltip label={hint ?? (open ? "Hide its text" : "Show its text")}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
        onClick={onToggle}
        className="flex min-w-0 shrink items-start gap-1 rounded-md px-1 py-1 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon
          name="right"
          size={14}
          className={`mt-0.5 shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span
            className={`text-sm break-words ${derived ? "text-muted italic" : "font-medium"} ${dim ? "opacity-60" : ""}`}
          >
            {name}
          </span>
          {detail}
        </span>
      </button>
    </Tooltip>
  )
}

/** The block's ⋯ menu trigger, for a `Menu`. */
export function BlockMenuButton({
  label,
  ...props
}: { label: string } & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Button variant="ghost" className="size-8 shrink-0 px-0!" aria-label={label} {...props}>
      <Icon name="more" />
    </Button>
  )
}

/** The header's button that shows or hides the block's options (a prompt's role, position…). */
export function BlockOptionsToggle({
  open,
  onToggle,
  label,
  hint
}: {
  open: boolean
  onToggle: () => void
  /** "Options of <name>". */
  label: string
  hint: string
}) {
  return (
    <IconButton
      label={label}
      hint={hint}
      icon="sliders"
      aria-expanded={open}
      className={open ? "bg-surface-raised text-text" : ""}
      onClick={onToggle}
    />
  )
}

/** The options' panel, under the header or in a section. */
export function BlockOptions({ children }: { children: ReactNode }) {
  return <div className="border-t border-border bg-surface-raised/50 px-3 py-3">{children}</div>
}

/** What the block opens to, under its header: its text. */
export function BlockBody({ children, dim = false }: { children: ReactNode; dim?: boolean }) {
  return <div className={`border-t border-border px-2 pt-2 pb-2 ${dim ? "opacity-70" : ""}`}>{children}</div>
}

/**
 * A section folded inside the opened block (a note's settings): a row with its name and a short
 * summary that opens it, then its options' panel.
 */
export function BlockSection({
  open,
  onToggle,
  title,
  summary,
  hint,
  label,
  children
}: {
  open: boolean
  onToggle: () => void
  title: string
  summary?: ReactNode
  hint: string
  /** Whose section, for its accessible name: "<title> of <label>". */
  label: string
  children: ReactNode
}) {
  return (
    <div className="border-t border-border">
      <Tooltip label={hint}>
        <button
          type="button"
          data-layout-audit-ignore="inset: Disclosure is the full-width section header"
          aria-expanded={open}
          aria-label={`${title} of ${label}`}
          onClick={onToggle}
          className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          <Icon
            name="right"
            size={14}
            className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          />
          <span className="font-medium">{title}</span>
          {!open && summary && <span className="min-w-0 truncate text-xs text-muted">{summary}</span>}
        </button>
      </Tooltip>
      {open && <BlockOptions>{children}</BlockOptions>}
    </div>
  )
}

/** A list of blocks' Expand all and Collapse all. */
export function ExpandCollapseAll({
  onExpand,
  onCollapse,
  expandHint,
  collapseHint,
  anyOpen,
  allOpen,
  compact = false,
  start,
  children
}: {
  /** What leads the row on its left, the list's save cluster say: one row, no empty space (DESIGN §10.1). */
  start?: ReactNode
  onExpand: () => void
  onCollapse: () => void
  expandHint: string
  collapseHint: string
  anyOpen: boolean
  allOpen: boolean
  /** A side panel's: small ghost buttons at the end. */
  compact?: boolean
  /** More buttons after them. */
  children?: ReactNode
}) {
  const variant = compact ? "ghost" : "secondary"
  const small = compact ? "h-7 px-2" : ""
  return (
    <div className={`flex flex-wrap items-center gap-1 ${compact ? "justify-end" : "sm:gap-2"}`}>
      {start !== undefined && <div className="mr-auto flex items-center">{start}</div>}
      <Button variant={variant} className={small} disabled={compact && allOpen} hint={expandHint} onClick={onExpand}>
        Expand all
      </Button>
      <Button
        variant={variant}
        className={small}
        disabled={compact && !anyOpen}
        hint={collapseHint}
        onClick={onCollapse}
      >
        Collapse all
      </Button>
      {children}
    </div>
  )
}
