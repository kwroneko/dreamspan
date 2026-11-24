// What the preset and model pickers are built from: the popover they open in (the composer's
// chip and the side panel tabs' dropdowns), the filter, and the list of radio rows, each with
// a muted line under its name and an optional icon button beside it that acts on the row
// without choosing it or closing the popover.
import { type ReactNode, type Ref, type RefObject, useEffect, useImperativeHandle, useRef, useState } from "react"
import { WindowedList, type WindowedListHandle } from "../../ui/WindowedList.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { rowActionInsetClass } from "../../ui/rowSpacing.ts"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"

/** Where focus goes as a picker opens: the filter, or on a touch screen the current row (no keyboard pops up). */
type PickerFocus = "search" | "current"

export interface PickerBodyProps {
  readonly focusRef: RefObject<HTMLElement | null>
  readonly focus: PickerFocus
  /** Called once a row is chosen: the popover closes. */
  readonly onChosen: () => void
}

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches

/**
 * A picker's popover. `children` renders its body (a registered picker) given where focus goes
 * and how to close; `footer` the rows under it ("Edit preset…").
 */
export function PickerPopover({
  title,
  trigger,
  triggerLabel,
  triggerClassName,
  hint,
  side = "top",
  onOpen,
  children,
  footer
}: {
  title: string
  trigger: ReactNode
  triggerLabel: string
  triggerClassName?: string
  hint?: ReactNode
  side?: "top" | "bottom"
  /** Each time it opens: read the times under the names again. */
  onOpen?: () => void
  children: (body: PickerBodyProps) => ReactNode
  footer?: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const focusRef = useRef<HTMLElement>(null)
  const [focus, setFocus] = useState<PickerFocus>("search")
  const close = () => setOpen(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setFocus(coarse() ? "current" : "search")
          onOpen?.()
        }
        setOpen(next)
      }}
      trigger={trigger}
      triggerLabel={triggerLabel}
      hint={hint}
      hintSide={side}
      side={side}
      title={title}
      initialFocus={focusRef}
      // Wider and taller than a plain choice list: a name, its line and a button per row.
      wide
      {...(triggerClassName === undefined ? {} : { triggerClassName })}
    >
      {children({ focusRef, focus, onChosen: close })}
      {footer && <div className="flex shrink-0 flex-col border-t border-border pt-2">{footer(close)}</div>}
    </Popover>
  )
}

/** The filter above a picker's list. */
export function PickerSearch({
  label,
  placeholder,
  value,
  onChange,
  inputRef,
  controls,
  navigate
}: {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  inputRef?: RefObject<HTMLElement | null> | undefined
  controls: string
  /** Windowed lists navigate their full data rather than just the mounted rows. */
  navigate?: (key: "ArrowDown" | "Enter") => void
}) {
  return (
    <Input
      ref={inputRef as RefObject<HTMLInputElement | null> | undefined}
      type="search"
      aria-label={label}
      aria-controls={controls}
      placeholder={placeholder}
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (navigate && (event.key === "ArrowDown" || (event.key === "Enter" && !event.nativeEvent.isComposing))) {
          event.preventDefault()
          navigate(event.key)
          return
        }
        // Non-windowed lists have every row in the DOM.
        const rows = document.getElementById(controls)?.querySelectorAll<HTMLElement>("[role=radio]")
        if (!rows?.length) return
        if (event.key === "ArrowDown") {
          event.preventDefault()
          ;([...rows].find((row) => row.getAttribute("aria-checked") === "true") ?? rows[0])!.focus()
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault()
          rows[0]!.click()
        }
      }}
      className="shrink-0"
    />
  )
}

const radio = (row: HTMLElement) => row.querySelector<HTMLElement>("[role=radio]")
const rowAction = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-picker-action]:enabled") ?? radio(row)

export interface PickerListNavigation {
  readonly searchKey: (key: "ArrowDown" | "Enter") => void
}

interface PickerRowAction {
  readonly label: string
  /** Its tooltip: what it does. */
  readonly hint: string
  readonly icon: IconName
  readonly pending?: boolean
  readonly onClick: () => void
}

export interface PickerItem {
  readonly value: string
  readonly label: string
  /** The muted line under the name. */
  readonly detail?: string
  /** Beside the name ("Archived"). */
  readonly badge?: ReactNode
  /** Before the name and its line: a card's portrait. */
  readonly leading?: ReactNode
  /** What choosing it does, and the exact times behind the line. */
  readonly tooltip: ReactNode
  readonly action?: PickerRowAction
}

/**
 * The rows, as radios. An action that takes its row out of the list (archiving) moves focus to
 * the row that takes its place, so the keyboard stays in the list and the popover stays open.
 */
export function PickerList({
  ref,
  id,
  title,
  items,
  value,
  onChoose,
  empty,
  focusRef,
  fallbackFocus,
  rowSize = 48
}: {
  ref: Ref<PickerListNavigation>
  id: string
  title: string
  items: ReadonlyArray<PickerItem>
  /** A row's usual height in px, for the rows not yet measured. */
  rowSize?: number
  value: string
  onChoose: (value: string) => void
  empty: ReactNode
  /** Given to the current row when focus starts there. */
  focusRef?: RefObject<HTMLElement | null> | undefined
  /** Where focus goes when an action empties the list. */
  fallbackFocus?: RefObject<HTMLElement | null> | undefined
}) {
  const list = useRef<WindowedListHandle>(null)
  const current = Math.max(
    0,
    items.findIndex((item) => item.value === value)
  )
  useImperativeHandle(ref, () => ({
    searchKey: (key) => {
      if (key === "ArrowDown") list.current?.focusItem(current, radio)
      else if (items[0]) onChoose(items[0].value)
    }
  }))
  // Where focus goes once an action has changed the rows.
  const refocus = useRef<{ index: number; value: string } | null>(null)
  const values = items.map((item) => item.value).join("\n")
  const shownValues = useRef(values)
  useEffect(() => {
    const element = document.getElementById(id)
    const before = shownValues.current
    if (element === null || before === values) return
    shownValues.current = values
    const wanted = refocus.current
    refocus.current = null
    // A new filter starts at the top of its rows, unless focus is in the list (or the rows only
    // just loaded, shown at the current one).
    if (wanted === null || document.activeElement instanceof HTMLInputElement) {
      if (before !== "" && !element.contains(document.activeElement)) element.scrollTop = 0
      return
    }
    // Still there (archiving failed, or the current preset stays listed): focus it again.
    const same = items.findIndex((item) => item.value === wanted.value)
    if (items.length === 0) fallbackFocus?.current?.focus()
    else list.current?.focusItem(same >= 0 ? same : Math.min(wanted.index, items.length - 1), rowAction)
  }, [values]) // eslint-disable-line react-hooks/exhaustive-deps -- once the rows have changed
  if (items.length === 0)
    return (
      <div id={id} role="radiogroup" aria-label={title} className="flex min-h-0 flex-col p-2">
        <div className="px-2 py-1.5 text-sm text-muted">{empty}</div>
      </div>
    )
  // Hundreds of presets or thousands of cards: only the rows in view (and a few more) mount.
  return (
    <WindowedList
      ref={list}
      id={id}
      role="radiogroup"
      aria-label={title}
      className="flex min-h-0 flex-col overflow-y-auto p-2"
      items={items}
      itemKey={itemKey}
      estimateSize={rowSize}
      gap={false}
      initialIndex={current}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (target.getAttribute("role") !== "radio") return
        const index = Number(target.closest<HTMLElement>("[data-index]")?.dataset.index)
        switch (event.key) {
          case "ArrowDown":
            list.current?.focusItem(index + 1, radio)
            break
          case "ArrowUp":
            if (index === 0) fallbackFocus?.current?.focus()
            else list.current?.focusItem(index - 1, radio)
            break
          case "Home":
            list.current?.focusItem(0, radio)
            break
          case "End":
            list.current?.focusItem(items.length - 1, radio)
            break
          default:
            return
        }
        event.preventDefault()
      }}
      renderItem={(item, index) => {
        const checked = item.value === value
        return (
          <div
            data-picker-row={item.value}
            className={`grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-md hover:bg-surface-raised ${item.action ? `${rowActionInsetClass} [--row-action-inset:2rem]` : ""}`}
          >
            <Tooltip label={item.tooltip}>
              <button
                ref={checked ? (focusRef as RefObject<HTMLButtonElement | null> | undefined) : undefined}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={item.label}
                {...(item.detail ? { "aria-description": item.detail } : {})}
                onClick={() => onChoose(item.value)}
                className={`grid w-full min-w-0 items-start gap-x-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus aria-checked:font-medium ${item.leading ? "grid-cols-[1rem_auto_minmax(0,1fr)]" : "grid-cols-[1rem_1fr]"}`}
              >
                <span className={`pt-0.5 text-accent ${item.leading ? "row-span-2 self-center" : ""}`}>
                  {checked && <Icon name="check" size={14} />}
                </span>
                {item.leading && (
                  <span aria-hidden className="row-span-2 flex self-center">
                    {item.leading}
                  </span>
                )}
                <span
                  className={`flex min-w-0 flex-wrap items-center gap-x-1.5 [overflow-wrap:anywhere] ${item.leading ? "self-end" : ""}`}
                >
                  <span className="min-w-0">{item.label}</span>
                  {item.badge}
                </span>
                {item.detail && (
                  <span
                    className={`text-xs font-normal text-muted [overflow-wrap:anywhere] ${item.leading ? "col-start-3 self-start" : "col-start-2"}`}
                  >
                    {item.detail}
                  </span>
                )}
              </button>
            </Tooltip>
            {item.action && (
              <IconButton
                data-picker-action=""
                label={item.action.label}
                hint={item.action.hint}
                icon={item.action.icon}
                disabled={item.action.pending === true}
                onClick={() => {
                  refocus.current = { index, value: item.value }
                  item.action!.onClick()
                }}
              />
            )}
          </div>
        )
      }}
    />
  )
}

const itemKey = (item: PickerItem) => item.value

/** A full-width row under the list: an action ("New preset…") or a link ("Manage connections…"). */
export const pickerRowClass =
  "flex w-full shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-accent outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"

export function PickerFooterButton({
  hint,
  icon,
  onClick,
  children
}: {
  hint: string
  icon?: IconName
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={hint}>
      <button type="button" onClick={onClick} className={pickerRowClass}>
        {icon && <Icon name={icon} size={14} />}
        {children}
      </button>
    </Tooltip>
  )
}

export function ChatLock({
  lock,
  kind
}: {
  lock: { readonly locked: boolean; readonly disabled: boolean; readonly change: (locked: boolean) => void } | undefined
  kind: "preset" | "model"
}) {
  if (!lock) return null
  return (
    <PickerLockRow
      checked={lock.locked}
      disabled={lock.disabled}
      onCheckedChange={lock.change}
      hint={
        lock.disabled
          ? `Choose a ${kind} before locking this chat.`
          : `This chat keeps this ${kind} when you change it elsewhere.`
      }
    >
      Lock for this chat
    </PickerLockRow>
  )
}

/** A picker's lock switch, above its search with a divider below (Lock for this chat, the persona lock). */
export function PickerLockRow({
  checked,
  disabled,
  onCheckedChange,
  hint,
  children
}: {
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  hint: string
  children: ReactNode
}) {
  return (
    <div className="shrink-0 border-b border-border pb-2">
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} hint={hint}>
        {children}
      </Switch>
    </div>
  )
}
