// A side panel's navigation, as two rows that never wrap. Tools: icon and label, in order, as
// many as fit, the rest under More (the one open always shows). Subjects (a chat's characters):
// a strip of their own, each with its portrait, scrolling sideways when there are many. Each row
// is its own tab list over the same panels, so a character named "Model" is never one of the tools.
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import type { AvatarCrop } from "@rp/shared/media.ts"
import { Avatar } from "./Avatar.tsx"
import { Icon, type IconName } from "./Icon.tsx"
import { Menu, MenuItem } from "./Menu.tsx"
import { UnsavedDot } from "./UnsavedChanges.tsx"
import { Tooltip } from "./Tooltip.tsx"

interface ToolTab {
  readonly dirty?: boolean | undefined
  readonly value: string
  readonly label: string
  readonly icon: IconName
  /** What the tab holds, beside it on hover and focus, and under it in More. */
  readonly description?: string | undefined
}

interface SubjectTab {
  readonly dirty?: boolean | undefined
  readonly value: string
  readonly label: string
  /** A portrait; without one the tab shows `icon` (the cast's own tab, say). */
  readonly avatar?:
    | {
        readonly id: string
        readonly name: string
        readonly mediaId: string | null
        readonly crop?: AvatarCrop | undefined
      }
    | undefined
  readonly icon?: IconName | undefined
  /** A word beside the name: "you" on the persona. */
  readonly note?: string | undefined
}

// The icon over its label, small, as a phone's tab bar: about six fit in the panel's default width.
const toolClass =
  "relative flex shrink-0 flex-col items-center gap-0.5 rounded-md border-b-2 border-transparent px-1.5 pt-1 pb-0.5 text-xs whitespace-nowrap text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
const GAP = 2
/** The subjects' strip's gap (gap-1). */
const GAP_SUBJECT = 4
const MORE = "More"

/** Which tools show: a prefix that fits beside More, with the open one swapped in when it doesn't. */
const fitting = (widths: ReadonlyArray<number>, more: number, room: number, active: number) => {
  const total = widths.reduce((sum, width) => sum + width + GAP, 0)
  if (total <= room) return widths.map((_, index) => index)
  const shown: Array<number> = []
  let used = more + GAP
  for (const [index, width] of widths.entries()) {
    if (used + width + GAP > room) break
    shown.push(index)
    used += width + GAP
  }
  if (active >= 0 && !shown.includes(active)) {
    while (shown.length > 0 && used + widths[active]! + GAP > room) used -= widths[shown.pop()!]! + GAP
    shown.push(active)
  }
  return shown
}

export function ToolTabs({
  tabs,
  value,
  onValueChange,
  label,
  moreLabel = MORE,
  end
}: {
  tabs: ReadonlyArray<ToolTab>
  /** The open tab; one that isn't a tool leaves none selected. */
  value: string
  onValueChange: (value: string) => void
  label: string
  /** The More button's accessible name, its text in it: "More tools". */
  moreLabel?: string
  /** After the row: a close button, say. */
  end?: ReactNode
}) {
  const row = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<number | null>(null)
  const [widths, setWidths] = useState<ReadonlyArray<number>>([])
  const key = tabs.map((tab) => `${tab.value}\u0000${tab.label}`).join("\u0001")
  useLayoutEffect(() => {
    const element = row.current
    const measure = ruler.current
    if (!element || !measure) return
    const read = () => {
      setRoom(element.clientWidth)
      setWidths([...measure.children].map((child) => (child as HTMLElement).offsetWidth))
    }
    const observer = new ResizeObserver(read)
    observer.observe(element)
    read()
    return () => observer.disconnect()
  }, [key])
  const active = tabs.findIndex((tab) => tab.value === value)
  const ready = room !== null && widths.length === tabs.length + 1
  const shown = ready ? fitting(widths.slice(0, -1), widths.at(-1)!, room, active) : tabs.map((_, index) => index)
  const visible = tabs.filter((_, index) => shown.includes(index))
  const hidden = tabs.filter((_, index) => !shown.includes(index))
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div ref={row} className="relative min-w-0 flex-1 overflow-hidden">
        {/* Every tool at its natural width, measured, never seen. */}
        <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute flex">
          {tabs.map((tab) => (
            <span key={tab.value} className={toolClass}>
              <Icon name={tab.icon} />
              {tab.label}
            </span>
          ))}
          <span className={toolClass}>
            <Icon name="more" />
            {MORE}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as string)}>
            <BaseTabs.List aria-label={label} className={`flex items-center gap-0.5 ${ready ? "" : "invisible"}`}>
              {visible.map((tab) => {
                const button = (
                  <BaseTabs.Tab
                    data-layout-audit-ignore="inset: Tabs form the panel navigation strip"
                    key={tab.value}
                    value={tab.value}
                    data-unsaved={tab.dirty || undefined}
                    aria-description={tab.dirty ? "Unsaved changes" : undefined}
                    className={`group ${toolClass} data-active:border-accent data-active:text-text`}
                  >
                    <Icon name={tab.icon} className="group-data-active:text-accent" />
                    {tab.label}
                    {tab.dirty && <UnsavedDot />}
                  </BaseTabs.Tab>
                )
                return tab.description ? (
                  <Tooltip key={tab.value} label={tab.description} side="bottom">
                    {button}
                  </Tooltip>
                ) : (
                  button
                )
              })}
            </BaseTabs.List>
          </BaseTabs.Root>
          {hidden.length > 0 && (
            <Menu
              label={`More of the ${label.toLowerCase()}`}
              trigger={
                <button
                  data-layout-audit-ignore="inset: More tools continues the tab strip"
                  type="button"
                  aria-label={moreLabel}
                  className={toolClass}
                >
                  <Icon name="more" />
                  {MORE}
                  {hidden.some((tab) => tab.dirty) && <UnsavedDot />}
                </button>
              }
            >
              {hidden.map((tab) => (
                <MenuItem
                  key={tab.value}
                  icon={tab.icon}
                  description={tab.description}
                  onClick={() => onValueChange(tab.value)}
                >
                  <span className="relative pr-3">
                    {tab.label}
                    {tab.dirty && <UnsavedDot />}
                  </span>
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      </div>
      {end}
    </div>
  )
}

/**
 * The subjects' strip: portraits and names, the open one marked, scrolled into view. When the
 * names don't all fit, the others show their portrait only (the name on hover and to a screen
 * reader), and the open one keeps its name if it still fits, so ten characters fit a panel's
 * width without scrolling.
 */
export function SubjectTabs({
  tabs,
  value,
  onValueChange,
  label
}: {
  tabs: ReadonlyArray<SubjectTab>
  value: string
  onValueChange: (value: string) => void
  label: string
}) {
  const list = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  // The strip's width, and each subject's with and without its name.
  const [room, setRoom] = useState<number | null>(null)
  const [widths, setWidths] = useState<ReadonlyArray<{ full: number; short: number }>>([])
  const key = tabs.map((tab) => `${tab.value}\u0000${tab.label}\u0000${tab.note ?? ""}`).join("\u0001")
  useLayoutEffect(() => {
    const strip = list.current
    const measure = ruler.current
    if (!strip || !measure) return
    const read = () => {
      setRoom(strip.clientWidth)
      const [full, short] = [...measure.children].map((row) =>
        [...row.children].map(
          (child) => (child as HTMLElement).offsetWidth + parseFloat(getComputedStyle(child).marginLeft) + GAP_SUBJECT
        )
      )
      setWidths((full ?? []).map((width, index) => ({ full: width, short: short?.[index] ?? width })))
    }
    const observer = new ResizeObserver(read)
    observer.observe(strip)
    read()
    return () => observer.disconnect()
  }, [key])
  useLayoutEffect(() => {
    // After layout (portraits and fonts change widths), and sideways only: the page never scrolls for it.
    const frame = requestAnimationFrame(() => {
      const strip = list.current
      const open = strip?.querySelector<HTMLElement>("[aria-selected=true]")
      if (!strip || !open) return
      const box = strip.getBoundingClientRect()
      const at = open.getBoundingClientRect()
      if (at.left < box.left) strip.scrollLeft -= box.left - at.left + 8
      else if (at.right > box.right) strip.scrollLeft += at.right - box.right + 8
    })
    return () => cancelAnimationFrame(frame)
  }, [value, key, room, widths])
  if (tabs.length === 0) return null
  const ready = room !== null && widths.length === tabs.length
  const sum = (pick: (width: { full: number; short: number }, index: number) => number) =>
    widths.reduce((total, width, index) => total + pick(width, index), 0)
  const open = tabs.findIndex((tab) => tab.value === value)
  const compact = ready && sum((width) => width.full) > room
  // Compact, the open one keeps its name when that still fits beside the others' portraits.
  const named =
    compact && open >= 0 && sum((width, index) => (index === open ? width.full : width.short)) <= room ? open : -1
  const chip = (tab: SubjectTab, short: boolean) => (
    <>
      {tab.avatar ? (
        <Avatar
          id={tab.avatar.id}
          name={tab.avatar.name}
          mediaId={tab.avatar.mediaId}
          crop={tab.avatar.crop}
          size="chip"
        />
      ) : (
        tab.icon && <Icon name={tab.icon} />
      )}
      <span className={short ? "sr-only" : "min-w-0 truncate py-1"}>{tab.label}</span>
      {tab.note && !short && (
        <span aria-hidden="true" className="shrink-0 rounded-sm bg-surface-raised px-1 text-xs text-muted">
          {tab.note}
        </span>
      )}
    </>
  )
  // Short, the persona is set apart by a rule instead of its word ("you").
  const chipClass = (tab: SubjectTab, short: boolean) =>
    `relative flex max-w-44 shrink-0 items-center gap-1.5 rounded-md border py-0.5 text-sm ${
      short && tab.note ? "ml-2 before:absolute before:inset-y-1 before:-left-1.5 before:w-px before:bg-border" : ""
    } ${
      tab.avatar ? `border-border text-text ${short ? "px-0.5" : "pr-2 pl-0.5"}` : "border-transparent px-2 text-muted"
    }`
  return (
    <div className="relative min-w-0 overflow-hidden">
      {/* Every subject with and without its name, measured, never seen: whether the names fit. */}
      <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute w-0">
        {[false, true].map((short) => (
          <div key={String(short)} className="flex">
            {tabs.map((tab) => (
              <span key={tab.value} className={chipClass(tab, short && tab.avatar !== undefined)}>
                {chip(tab, short && tab.avatar !== undefined)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as string)}>
        <BaseTabs.List
          ref={list}
          aria-label={label}
          className="flex items-center gap-1 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]"
        >
          {tabs.map((tab, index) => {
            const short = compact && tab.avatar !== undefined && index !== named
            return (
              <BaseTabs.Tab
                data-layout-audit-ignore="inset: Tabs form the panel navigation strip"
                key={tab.value}
                value={tab.value}
                data-unsaved={tab.dirty || undefined}
                title={tab.note ? `${tab.label} (${tab.note})` : tab.label}
                aria-description={
                  [tab.note, tab.dirty ? "Unsaved changes" : ""].filter(Boolean).join(". ") || undefined
                }
                className={`${chipClass(tab, short)} outline-none focus-visible:ring-2 focus-visible:ring-focus data-active:border-accent data-active:bg-surface-raised data-active:text-text ${
                  tab.avatar ? "hover:bg-surface-raised" : "hover:text-text"
                }`}
              >
                {chip(tab, short)}
                {tab.dirty && <UnsavedDot />}
              </BaseTabs.Tab>
            )
          })}
        </BaseTabs.List>
      </BaseTabs.Root>
    </div>
  )
}
