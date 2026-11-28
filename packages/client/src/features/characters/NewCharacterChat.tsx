import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Link, type LinkProps } from "@tanstack/react-router"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { sidebarCleared, useShellNavigation } from "./shellData.tsx"

/**
 * The Chats tab's start row (owner, 2026-11-24): its buttons side by side, sharing the row, in the
 * same slot and height in All chats and a character's chats, stacked only where even their short
 * labels don't fit. A button's " with <name>" (`StartWith`) shows only while every button's does
 * fit on the one row: otherwise all drop it together, and the crumb above names the character.
 */
export function StartRow({ children, characterLabel }: { children: ReactNode; characterLabel?: string }) {
  const row = useRef<HTMLDivElement>(null)
  const [short, setShort] = useState(false)
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const measure = () => {
      const withs = [...el.querySelectorAll<HTMLElement>("[data-start-with]")]
      if (withs.length === 0) return setShort(false)
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0
      const buttons = [...el.children] as HTMLElement[]
      // Each button's width with its names, whether or not they show now.
      const need = buttons.reduce((sum, button) => {
        const style = getComputedStyle(button)
        const edges = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const
        const inflow = [...button.children].filter((c) => getComputedStyle(c).position !== "absolute")
        const content = inflow.reduce((w, c) => w + c.getBoundingClientRect().width, 0)
        const between = (parseFloat(style.columnGap) || 0) * Math.max(0, inflow.length - 1)
        const hidden = [...button.querySelectorAll<HTMLElement>("[data-start-with]")]
          .filter((w) => getComputedStyle(w).position === "absolute")
          .reduce((w, s) => w + s.scrollWidth, 0)
        return sum + edges.reduce((w, k) => w + (parseFloat(style[k]) || 0), 0) + content + between + hidden
      }, 0)
      setShort(need + gap * Math.max(0, buttons.length - 1) > el.clientWidth + 0.5)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    void document.fonts.ready.then(measure)
    return () => observer.disconnect()
  }, [characterLabel])
  return (
    <div
      ref={row}
      data-sidebar-starts
      data-short={short || undefined}
      className="group/starts mt-2 flex flex-wrap gap-2 empty:hidden"
    >
      {children}
    </div>
  )
}

/** " with <name>" after a start button's label: dropped, with the others', where the row is too narrow. */
function StartWith({ name }: { name: string }) {
  return (
    <span
      data-start-with
      className="group-data-short/starts:invisible group-data-short/starts:absolute group-data-short/starts:start-0 group-data-short/starts:w-0 group-data-short/starts:overflow-hidden"
    >
      {" "}with {name}
    </span>
  )
}

/**
 * One of the start row's buttons: a link to a chat not made yet, with the app's open menu,
 * sharing the row with the others and never narrower than its label.
 */
export function SidebarStartLink({
  icon,
  label,
  name,
  hint,
  ...link
}: {
  icon: IconName
  label: string
  /** Who it starts with, after the label where the row has room; always in its accessible name. */
  name?: string
  hint: string
} & Pick<LinkProps, "to" | "params" | "search">) {
  const { picked } = useShellNavigation()
  return (
    <Tooltip label={hint}>
      <Link
        {...link}
        {...linkMenuProps}
        aria-label={name === undefined ? label : `${label} with ${name}`}
        onClick={() => picked()}
        className="relative flex min-w-max flex-[1_1_0] items-center justify-center gap-1 overflow-hidden rounded-md border border-border bg-surface px-1.5 py-3 text-sm font-medium text-accent outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon name={icon} size={16} className="shrink-0" />
        <span className="whitespace-nowrap">
          {label}
          {name !== undefined && <StartWith name={name} />}
        </span>
      </Link>
    </Tooltip>
  )
}

/** "New Roleplay with <name>" above a character's chats (owner, 2026-11-24): their pending chat. */
export function NewCharacterChat({ entityId, label }: { entityId: EntityId; label: string }) {
  return (
    <SidebarStartLink
      to="/cards/$entityId/chat"
      params={{ entityId }}
      search={{ ...sidebarCleared, character: entityId, panel: `card:${entityId}` }}
      icon="chat"
      label="New Roleplay"
      name={label}
      hint={`Start a new roleplay with ${label}.`}
    />
  )
}

/** "New Roleplay": the chat with nobody in it yet (`/new/chat`). */
export function NewRoleplayStart() {
  return (
    <SidebarStartLink
      to="/new/chat"
      icon="chat"
      label="New Roleplay"
      hint="Start a new roleplay chat. Add characters from the Cast tab, or send with nobody in it."
    />
  )
}
