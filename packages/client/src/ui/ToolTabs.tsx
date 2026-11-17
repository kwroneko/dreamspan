// A side panel's tools: icon and label, as many as fit in the user's order, the rest under More
// in the same order (owner, 2026-11-17, DESIGN §10.1 "Tab order"). The open tool, when it's
// under More, shows as a guest after a divider just before More, never at a place that isn't
// its own; its entry in More stays where it is, marked "Shown above". Tools reorder by dragging
// (a long press first on touch), within the row, onto More (to the end), inside More and back
// up; and from each one's own menu (right-click or long press) and Arrange tabs…, so no order
// depends on a gesture.
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Button } from "./Button.tsx"
import { Dialog, DialogActions } from "./Dialog.tsx"
import { Icon, type IconName } from "./Icon.tsx"
import { ContextMenu, Menu, MenuItem, MenuSeparator, PointMenu } from "./Menu.tsx"
import { panelToolClass, useInitialTabFocus } from "./PanelTabs.tsx"
import { SortableList } from "./SortableList.tsx"
import { Badge } from "./Surface.tsx"
import { fitTools, moved, placedBefore } from "./tabOrder.ts"
import { IconButton, Tooltip } from "./Tooltip.tsx"
import { UnsavedDot } from "./UnsavedChanges.tsx"

export interface ToolTab {
  readonly dirty?: boolean | undefined
  readonly value: string
  readonly label: string
  readonly icon: IconName
  /** What the tab holds, beside it on hover and focus, and under it in More. */
  readonly description?: string | undefined
  /** Offered only once its chat is saved; marked `data-saved-only` so the tab strip says which. */
  readonly savedOnly?: boolean | undefined
}

const MORE = "More"
/** The guest's divider: a rule between the tools in order and the open one shown out of it. */
const DIVIDER = "h-7 w-px shrink-0 self-center bg-border"
/** How long a finger rests on a tool before it drags (Base UI's long press opens its menu then too). */
const LONG_PRESS = 500
/** How long a dragged tool rests on More before More opens, to drop it at a place inside. */
const SPRING = 600

type Place = "strip" | "more"
interface OrderAction {
  readonly label: string
  readonly icon: IconName
  readonly description: string
  readonly disabled: boolean
  readonly run: () => void
}
/** Where a dragged tool would land: before the tool at `before` in the order, or at the end (More). */
type Over = { readonly zone: "strip" | "menu"; readonly before: number } | { readonly zone: "more" }
interface Drag {
  readonly value: string
  readonly over: Over | null
  readonly x: number
  readonly y: number
}
interface Press {
  readonly value: string
  readonly place: Place
  readonly pointerId: number
  readonly touch: boolean
  readonly x: number
  readonly y: number
  readonly element: HTMLElement
  started: boolean
  armed: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

/** Swallows the click a drag's release makes, so dropping a tool never also opens it. */
const swallowClick = () => {
  const stop = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener("click", stop, { capture: true, once: true })
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0)
}

export function ToolTabs({
  tabs,
  value,
  onValueChange,
  label,
  moreLabel = MORE,
  end,
  focusOnMount = false,
  onReorder,
  onResetOrder,
  reordered = false
}: {
  /** In the user's order. */
  tabs: ReadonlyArray<ToolTab>
  /** The open tab; one that isn't a tool leaves none selected. */
  value: string
  onValueChange: (value: string) => void
  label: string
  /** The More button's accessible name, its text in it: "More tools". */
  moreLabel?: string
  /** After the row: a close button, say. */
  end?: ReactNode
  /** Restore the selected tab after a pending chat becomes a saved chat. */
  focusOnMount?: boolean
  /** Arranges the tools: every tool's value, in the new order. Without it they don't move. */
  onReorder?: ((values: ReadonlyArray<string>) => void) | undefined
  /** Back to the usual order. */
  onResetOrder?: (() => void) | undefined
  /** Whether the order differs from the usual one, so Reset tab order has something to do. */
  reordered?: boolean
}) {
  const row = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const stripTabs = useRef(new Map<string, HTMLElement>())
  const menuItems = useRef(new Map<string, HTMLElement>())
  const [room, setRoom] = useState<number | null>(null)
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({})
  const [chrome, setChrome] = useState({ more: 0, divider: 0 })
  const [menuOpen, setMenuOpen] = useState(false)
  /** Which row tool's menu is open. */
  const [contextFor, setContextFor] = useState<string | null>(null)
  /** A More entry's menu, at the pointer (an entry stays More's item, so it can't be a trigger). */
  const [pointFor, setPointFor] = useState<{ readonly value: string; readonly x: number; readonly y: number } | null>(
    null
  )
  const [arranging, setArranging] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const key = tabs.map((tab) => `${tab.value}\u0000${tab.label}`).join("\u0001")
  useLayoutEffect(() => {
    const element = row.current
    const measure = ruler.current
    if (!element || !measure) return
    const read = () => {
      setRoom(element.clientWidth)
      const next: Record<string, number> = {}
      for (const child of measure.querySelectorAll<HTMLElement>("[data-measure-tab]"))
        next[child.dataset.measureTab!] = child.offsetWidth
      setWidths(next)
      setChrome({
        more: measure.querySelector<HTMLElement>("[data-measure-more]")?.offsetWidth ?? 0,
        divider: (() => {
          const divider = measure.querySelector<HTMLElement>("[data-measure-divider]")
          if (!divider) return 0
          const style = getComputedStyle(divider)
          return divider.offsetWidth + parseFloat(style.marginLeft) + parseFloat(style.marginRight)
        })()
      })
    }
    const observer = new ResizeObserver(read)
    observer.observe(element)
    read()
    return () => observer.disconnect()
  }, [key])
  const values = tabs.map((tab) => tab.value)
  const active = values.indexOf(value)
  const ready = room !== null && tabs.every((tab) => widths[tab.value] !== undefined)
  useInitialTabFocus(row, ready, focusOnMount)
  const fitFor = (order: ReadonlyArray<string>, open: number) =>
    ready
      ? fitTools(
          order.map((entry) => widths[entry]!),
          chrome.more,
          chrome.divider,
          room,
          open
        )
      : { count: order.length, guest: false }
  const { count, guest: hasGuest } = fitFor(values, active)
  const visible = tabs.slice(0, count)
  const hidden = tabs.slice(count)
  const guest = hasGuest ? tabs[active]! : null
  // More gone (everything fits now): it opens closed when it's back.
  if (hidden.length === 0 && menuOpen) setMenuOpen(false)
  const movable = onReorder !== undefined

  // The order's moves, each as the new order.
  const reorder = (next: ReadonlyArray<string>) => {
    if (next.some((entry, index) => entry !== values[index])) onReorder?.(next)
  }
  /** Out of More: the last place in the row where it shows (as a tool, not as the guest). */
  const outOfMore = (index: number) => {
    for (let at = Math.min(count, values.length - 1); at > 0; at--) {
      const next = moved(values, index, at)
      if (fitFor(next, -1).count > at) return next
    }
    return moved(values, index, 0)
  }
  const orderItems = (tab: ToolTab, place: Place): ReadonlyArray<OrderAction> => {
    const index = values.indexOf(tab.value)
    const last = values.length - 1
    const inMore = index >= count
    const vertical = place === "more"
    return [
      {
        label: vertical ? "Move up" : "Move left",
        icon: vertical ? "move-up" : "move-left",
        description: vertical ? "Moves this tab one place earlier." : "Moves this tab one place to the left.",
        disabled: index === 0,
        run: () => reorder(moved(values, index, index - 1))
      },
      {
        label: vertical ? "Move down" : "Move right",
        icon: vertical ? "move-down" : "move-right",
        description: vertical ? "Moves this tab one place later." : "Moves this tab one place to the right.",
        disabled: index === last,
        run: () => reorder(moved(values, index, index + 1))
      },
      {
        label: "Move to start",
        icon: "back",
        description: "Puts this tab first.",
        disabled: index === 0,
        run: () => reorder(moved(values, index, 0))
      },
      inMore
        ? {
            label: "Move out of More",
            icon: "insert-above",
            description: "Puts this tab at the end of the tabs shown in the row.",
            disabled: false,
            run: () => reorder(outOfMore(index))
          }
        : hidden.length > 0
          ? {
              label: "Move to More",
              icon: "more",
              description: "Puts this tab last, under More.",
              disabled: false,
              run: () => reorder(moved(values, index, last))
            }
          : {
              label: "Move to end",
              icon: "more",
              description: "Puts this tab last.",
              disabled: index === last,
              run: () => reorder(moved(values, index, last))
            }
    ]
  }
  const orderMenu = (tab: ToolTab, place: Place) => (
    <>
      {orderItems(tab, place).map((item) => (
        <MenuItem
          key={item.label}
          icon={item.icon}
          description={item.description}
          disabled={item.disabled}
          onClick={item.run}
        >
          {item.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        icon="layers"
        description="Opens a list of every tab, to put them in order."
        onClick={() => {
          setMenuOpen(false)
          setArranging(true)
        }}
      >
        Arrange tabs…
      </MenuItem>
      <MenuItem
        icon="undo"
        description="Puts the tabs back in their usual order."
        disabled={!reordered}
        onClick={() => onResetOrder?.()}
      >
        Reset tab order
      </MenuItem>
    </>
  )

  // Dragging. The handlers read the latest layout through this ref.
  const target = (x: number, y: number): Over | null => {
    const inside = (box: DOMRect, pad = 0) =>
      x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad
    const firstItem = hidden.map((tab) => menuItems.current.get(tab.value)).find((element) => element?.isConnected)
    const popup = menuOpen ? firstItem?.closest<HTMLElement>('[role="menu"]') : null
    if (popup && inside(popup.getBoundingClientRect())) {
      const at = hidden.findIndex((tab) => {
        const box = menuItems.current.get(tab.value)?.getBoundingClientRect()
        return box !== undefined && y < box.top + box.height / 2
      })
      return { zone: "menu", before: at === -1 ? values.length : count + at }
    }
    const more = moreButton.current?.getBoundingClientRect()
    if (more && inside(more, 4)) return { zone: "more" }
    const strip = row.current?.getBoundingClientRect()
    if (!strip || y < strip.top - 24 || y > strip.bottom + 24 || x < strip.left - 24 || x > (more?.left ?? strip.right))
      return null
    const at = visible.findIndex((tab) => {
      const box = stripTabs.current.get(tab.value)?.getBoundingClientRect()
      return box !== undefined && x < box.left + box.width / 2
    })
    return { zone: "strip", before: at === -1 ? count : at }
  }
  const drop = (dragged: string, over: Over | null) => {
    if (over === null) return
    if (over.zone === "more") reorder(moved(values, values.indexOf(dragged), values.length - 1))
    else reorder(placedBefore(values, dragged, over.before))
    if (over.zone === "strip") setMenuOpen(false)
  }
  const latest = useRef({ target, drop, menuOpen })
  useLayoutEffect(() => {
    latest.current = { target, drop, menuOpen }
  })
  const press = useRef<Press | null>(null)
  const spring = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const endPress = useRef<() => void>(() => {})
  useEffect(() => () => endPress.current(), [])
  const startPress = (tab: ToolTab, place: Place) => (event: React.PointerEvent<HTMLElement>) => {
    if (!movable || event.button !== 0 || press.current) return
    const touch = event.pointerType === "touch"
    const state: Press = {
      value: tab.value,
      place,
      pointerId: event.pointerId,
      touch,
      x: event.clientX,
      y: event.clientY,
      element: event.currentTarget,
      started: false,
      armed: !touch,
      timer: undefined
    }
    if (touch)
      state.timer = setTimeout(() => {
        state.armed = true
        // A row tool's long press is its context menu's own; a More entry's opens here.
        if (place === "more") setPointFor({ value: state.value, x: state.x, y: state.y })
      }, LONG_PRESS)
    press.current = state
    const begin = (x: number, y: number) => {
      state.started = true
      try {
        state.element.setPointerCapture(state.pointerId)
      } catch {
        // Gone already: the window's listeners still follow the pointer.
      }
      setContextFor(null)
      setPointFor(null)
      setDrag({ value: state.value, over: latest.current.target(x, y), x, y })
    }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== state.pointerId) return
      const distance = Math.hypot(moveEvent.clientX - state.x, moveEvent.clientY - state.y)
      if (!state.started) {
        // A finger that moves before the long press is scrolling or swiping, not dragging.
        if (!state.armed) {
          if (distance > 10) finish()
          return
        }
        if (distance <= (state.touch ? 8 : 5)) return
        begin(moveEvent.clientX, moveEvent.clientY)
      }
      const over = latest.current.target(moveEvent.clientX, moveEvent.clientY)
      setDrag({ value: state.value, over, x: moveEvent.clientX, y: moveEvent.clientY })
      if (over?.zone === "more" && !latest.current.menuOpen) {
        spring.current ??= setTimeout(() => setMenuOpen(true), SPRING)
      } else {
        clearTimeout(spring.current)
        spring.current = undefined
      }
    }
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== state.pointerId) return
      if (state.started) {
        swallowClick()
        latest.current.drop(state.value, latest.current.target(upEvent.clientX, upEvent.clientY))
      }
      finish()
    }
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === state.pointerId) finish()
    }
    // Once a finger has rested long enough to drag, its moves are the drag's, not a scroll.
    const holdTouch = (touchEvent: TouchEvent) => {
      if (state.armed || state.started) touchEvent.preventDefault()
    }
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && state.started) finish()
    }
    const finish = () => {
      clearTimeout(state.timer)
      clearTimeout(spring.current)
      spring.current = undefined
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("touchmove", holdTouch)
      window.removeEventListener("keydown", escape, true)
      if (press.current === state) press.current = null
      setDrag(null)
    }
    endPress.current = finish
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("touchmove", holdTouch, { passive: false })
    window.addEventListener("keydown", escape, true)
  }

  // Smooth reflow: a tool that changed place slides there from where it was.
  const positions = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const before = positions.current
    const after = new Map<string, number>()
    for (const [entry, element] of stripTabs.current) {
      if (!element.isConnected) continue
      const left = element.getBoundingClientRect().left
      after.set(entry, left)
      const was = before.get(entry)
      if (was !== undefined && Math.abs(was - left) > 1 && !reducedMotion())
        element.animate([{ transform: `translateX(${was - left}px)` }, { transform: "none" }], {
          duration: 180,
          easing: "ease-out"
        })
    }
    positions.current = after
  }, [key, count, guest?.value])

  const over = drag?.over ?? null
  const from = drag ? values.indexOf(drag.value) : -1
  /** A drop that would leave the order as it is shows no mark. */
  const lands = (before: number) => before !== from && before !== from + 1
  const dropMark = (zone: "strip" | "menu", index: number) => {
    if (over === null || over.zone !== zone || !lands(over.before)) return ""
    const last = zone === "strip" ? count : values.length
    if (over.before === index)
      return zone === "strip"
        ? "before:absolute before:inset-y-1 before:-left-0.5 before:w-0.5 before:rounded-full before:bg-accent"
        : "relative before:absolute before:inset-x-1 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-accent"
    if (over.before === last && index === last - 1)
      return zone === "strip"
        ? "after:absolute after:inset-y-1 after:-right-0.5 after:w-0.5 after:rounded-full after:bg-accent"
        : "relative after:absolute after:inset-x-1 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-accent"
    return ""
  }

  const toolTab = (tab: ToolTab, index: number, isGuest: boolean) => {
    const contextKey = tab.value
    const button = (
      <BaseTabs.Tab
        data-layout-audit-ignore="inset: Tabs form the panel navigation strip"
        key={tab.value}
        ref={(element: HTMLElement | null) => {
          if (element) stripTabs.current.set(tab.value, element)
          else stripTabs.current.delete(tab.value)
        }}
        value={tab.value}
        data-tab-value={tab.value}
        data-unsaved={tab.dirty || undefined}
        data-saved-only={tab.savedOnly || undefined}
        data-tab-guest={isGuest || undefined}
        aria-description={
          [isGuest ? "Its place is under More" : "", tab.dirty ? "Unsaved changes" : ""].filter(Boolean).join(". ") ||
          undefined
        }
        onPointerDown={startPress(tab, "strip")}
        className={`group ${panelToolClass} select-none data-active:border-accent data-active:text-text ${
          drag?.value === tab.value ? "opacity-50" : ""
        } ${isGuest ? "" : dropMark("strip", index)}`}
      >
        <Icon name={tab.icon} className="group-data-active:text-accent" />
        {tab.label}
        {tab.dirty && <UnsavedDot />}
      </BaseTabs.Tab>
    )
    const hint = isGuest ? `${tab.description ?? tab.label} Open now; its place is under More.` : tab.description
    const hinted = (
      <Tooltip key={tab.value} label={hint} enabled={hint !== undefined && drag === null} side="bottom">
        {button}
      </Tooltip>
    )
    if (!movable) return hint === undefined ? button : hinted
    return (
      <ContextMenu
        key={tab.value}
        label={`Actions for ${tab.label}`}
        open={contextFor === contextKey}
        onOpenChange={(open) => setContextFor(open ? contextKey : null)}
        trigger={hinted}
      >
        {orderMenu(tab, isGuest ? "more" : "strip")}
      </ContextMenu>
    )
  }

  const moreItem = (tab: ToolTab, at: number) => {
    const index = count + at
    const shownAbove = guest?.value === tab.value
    return (
      <MenuItem
        key={tab.value}
        ref={(element: HTMLElement | null) => {
          if (element) menuItems.current.set(tab.value, element)
          else menuItems.current.delete(tab.value)
        }}
        icon={tab.icon}
        description={shownAbove ? `${tab.description ?? tab.label} Open now, shown above.` : tab.description}
        data-tab-value={tab.value}
        data-shown-above={shownAbove || undefined}
        onPointerDown={startPress(tab, "more")}
        onContextMenu={(event) => {
          if (!movable) return
          event.preventDefault()
          setPointFor({ value: tab.value, x: event.clientX, y: event.clientY })
        }}
        className={`${drag?.value === tab.value ? "opacity-50" : ""} ${dropMark("menu", index)}`}
        onClick={() => onValueChange(tab.value)}
      >
        <span className="flex items-center gap-2">
          <span className="relative pr-3" data-saved-only={tab.savedOnly || undefined}>
            {tab.label}
            {tab.dirty && <UnsavedDot />}
          </span>
          {shownAbove && (
            <span aria-hidden="true" className="ml-auto flex items-center gap-1 text-xs text-muted">
              <Icon name="check" className="text-accent" />
              Shown above
            </span>
          )}
        </span>
      </MenuItem>
    )
  }

  const pointTab = tabs.find((tab) => tab.value === pointFor?.value)
  const dragged = drag ? tabs.find((tab) => tab.value === drag.value) : undefined
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div ref={row} className="relative min-w-0 flex-1 overflow-hidden">
        {/* Every tool at its natural width, More and the guest's divider, measured, never seen. */}
        <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute flex">
          {tabs.map((tab) => (
            <span key={tab.value} data-measure-tab={tab.value} className={panelToolClass}>
              <Icon name={tab.icon} />
              {tab.label}
            </span>
          ))}
          <span data-measure-more className={panelToolClass}>
            <Icon name="more" />
            {MORE}
          </span>
          <span data-measure-divider className={DIVIDER} />
        </div>
        <div className="flex items-center gap-0.5">
          <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as string)}>
            <BaseTabs.List aria-label={label} className={`flex items-center gap-0.5 ${ready ? "" : "invisible"}`}>
              {visible.map((tab, index) => toolTab(tab, index, false))}
              {guest && (
                <>
                  <span aria-hidden="true" data-tab-guest-divider className={DIVIDER} />
                  {toolTab(guest, values.indexOf(guest.value), true)}
                </>
              )}
            </BaseTabs.List>
          </BaseTabs.Root>
          {hidden.length > 0 && (
            <Menu
              hint={`Shows more ${label.toLowerCase()} tabs.`}
              label={`More of the ${label.toLowerCase()}`}
              open={menuOpen}
              onOpenChange={(open) => {
                // An item's own menu, or a drag, keeps More open under it.
                if (!open && (pointFor !== null || press.current?.started)) return
                setMenuOpen(open)
              }}
              trigger={
                <button
                  ref={moreButton}
                  data-layout-audit-ignore="inset: More tools continues the tab strip"
                  type="button"
                  aria-label={moreLabel}
                  className={`${panelToolClass} ${over?.zone === "more" ? "bg-surface-raised text-text ring-2 ring-accent" : ""}`}
                >
                  <Icon name="more" />
                  {MORE}
                  {hidden.some((tab) => tab.dirty) && <UnsavedDot />}
                </button>
              }
            >
              {hidden.map((tab, at) => moreItem(tab, at))}
              {movable && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon="layers"
                    description="Opens a list of every tab, to put them in order."
                    onClick={() => setArranging(true)}
                  >
                    Arrange tabs…
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
      </div>
      {end}
      {movable && (
        <PointMenu
          at={pointFor}
          onClose={() => setPointFor(null)}
          label={`Actions for ${pointTab?.label ?? ""}`}
        >
          {pointTab ? orderMenu(pointTab, "more") : null}
        </PointMenu>
      )}
      {movable && arranging && (
        <ArrangeTabs
          tabs={tabs}
          inRow={(order) => fitFor(order, -1).count}
          onReorder={reorder}
          onResetOrder={() => onResetOrder?.()}
          reordered={reordered}
          onClose={() => setArranging(false)}
        />
      )}
      {dragged &&
        drag &&
        createPortal(
          <div
            aria-hidden="true"
            data-layout-overlay="A dragged tab follows the pointer"
            className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text shadow-lg"
            style={{ left: drag.x + 12, top: drag.y + 12 }}
          >
            <Icon name={dragged.icon} className="text-accent" />
            {dragged.label}
          </div>,
          document.body
        )}
    </div>
  )
}

/** Every tool in a list, in order, to arrange with move buttons or by dragging (Arrange tabs…). */
function ArrangeTabs({
  tabs,
  inRow,
  onReorder,
  onResetOrder,
  reordered,
  onClose
}: {
  tabs: ReadonlyArray<ToolTab>
  /** How many tools of an order show in the row at its width now. */
  inRow: (order: ReadonlyArray<string>) => number
  onReorder: (values: ReadonlyArray<string>) => void
  onResetOrder: () => void
  reordered: boolean
  onClose: () => void
}) {
  const values = tabs.map((tab) => tab.value)
  const shown = inRow(values)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Arrange tabs">
      <SortableList
        items={tabs}
        itemKey={(tab) => tab.value}
        itemLabel={(tab) => tab.label}
        label="Tabs"
        onMove={(from, to) => onReorder(moved(values, from, to))}
      >
        {(tab, handle) => {
          const index = values.indexOf(tab.value)
          return (
            <div className="flex min-w-0 items-center gap-2 py-2">
              {handle}
              <Icon name={tab.icon} className="text-muted" />
              <span className="min-w-0 flex-1 truncate text-sm">{tab.label}</span>
              {index >= shown && <Badge>In More</Badge>}
              <IconButton
                icon="move-up"
                label={`Move ${tab.label} up`}
                hint="Moves this tab one place earlier."
                disabled={index === 0}
                onClick={() => onReorder(moved(values, index, index - 1))}
              />
              <IconButton
                icon="move-down"
                label={`Move ${tab.label} down`}
                hint="Moves this tab one place later."
                disabled={index === values.length - 1}
                onClick={() => onReorder(moved(values, index, index + 1))}
              />
            </div>
          )
        }}
      </SortableList>
      <DialogActions>
        <Button hint="Puts the tabs back in their usual order." disabled={!reordered} onClick={onResetOrder}>
          Reset tab order
        </Button>
        <Button variant="primary" hint="Closes this list; the order is already saved." onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
