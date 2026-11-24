// A side panel's navigation, as two rows that never wrap. Tools (ToolTabs.tsx): icon and label,
// in the user's order, as many as fit, the rest under More. Subjects (a chat's characters):
// a strip of their own, each with its portrait, scrolling sideways when there are many. Each row
// is its own tab list over the same panels, so a character named "Model" is never one of the tools.
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import { useLayoutEffect, useRef, useState } from "react"
import type { AvatarCrop } from "@dreamspan/shared/media.ts"
import { Avatar } from "./Avatar.tsx"
import { Icon, type IconName } from "./Icon.tsx"
import { UnsavedDot } from "./UnsavedChanges.tsx"

interface SubjectTab {
  readonly keepLabel?: boolean | undefined
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
export const panelToolClass =
  "relative flex shrink-0 flex-col items-center gap-0.5 rounded-md border-b-2 border-transparent px-1.5 pt-1 pb-0.5 text-xs whitespace-nowrap text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
/** The subjects' strip's gap (gap-1). */
const GAP_SUBJECT = 4
/** Wait for measurement so focusing a tab never targets the invisible sizing pass. */
export function useInitialTabFocus(list: { readonly current: HTMLDivElement | null }, ready: boolean, wanted: boolean) {
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (!ready || !wanted || restored.current) return
    const selected = list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (selected) {
      selected.focus({ preventScroll: true })
      restored.current = true
    }
  }, [list, ready, wanted])
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
  label,
  focusOnMount = false
}: {
  tabs: ReadonlyArray<SubjectTab>
  value: string
  onValueChange: (value: string) => void
  label: string
  focusOnMount?: boolean
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
  const ready = room !== null && widths.length === tabs.length
  useInitialTabFocus(list, ready, focusOnMount)
  if (tabs.length === 0) return null
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
              <span key={tab.value} className={chipClass(tab, short && tab.avatar !== undefined && !tab.keepLabel)}>
                {chip(tab, short && tab.avatar !== undefined && !tab.keepLabel)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as string)}>
        <BaseTabs.List
          ref={list}
          aria-label={label}
          className="flex items-center gap-1 overflow-x-auto overscroll-x-contain pb-1"
        >
          {tabs.map((tab, index) => {
            const short = compact && tab.avatar !== undefined && !tab.keepLabel && index !== named
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
