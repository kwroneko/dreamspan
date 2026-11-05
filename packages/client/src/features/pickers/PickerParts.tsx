// What the preset and model pickers are built from: the popover they open in (the composer's
// chip and the side panel tabs' dropdowns), the filter, and the list of radio rows, each with
// a muted line under its name and an optional icon button beside it that acts on the row
// without choosing it or closing the popover.
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react"
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
  controls
}: {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  inputRef?: RefObject<HTMLElement | null> | undefined
  controls: string
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
      className="shrink-0"
    />
  )
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
  /** What choosing it does, and the exact times behind the line. */
  readonly tooltip: ReactNode
  readonly action?: PickerRowAction
}

/**
 * The rows, as radios. An action that takes its row out of the list (archiving) moves focus to
 * the row that takes its place, so the keyboard stays in the list and the popover stays open.
 */
export function PickerList({
  id,
  title,
  items,
  value,
  onChoose,
  empty,
  focusRef,
  fallbackFocus
}: {
  id: string
  title: string
  items: ReadonlyArray<PickerItem>
  value: string
  onChoose: (value: string) => void
  empty: ReactNode
  /** Given to the current row when focus starts there. */
  focusRef?: RefObject<HTMLElement | null> | undefined
  /** Where focus goes when an action empties the list. */
  fallbackFocus?: RefObject<HTMLElement | null> | undefined
}) {
  const list = useRef<HTMLDivElement>(null)
  const [refocus, setRefocus] = useState<{ index: number; value: string } | null>(null)
  const values = items.map((item) => item.value).join("\n")
  useEffect(() => {
    if (refocus === null || list.current === null) return
    // Still there (archiving failed, or the current preset stays listed): focus it again.
    const rows = [...list.current.querySelectorAll<HTMLElement>("[data-picker-row]")]
    const same = rows.find((row) => row.dataset.pickerRow === refocus.value)
    const next = same ?? rows[Math.min(refocus.index, rows.length - 1)]
    const target = next?.querySelector<HTMLElement>("[data-picker-action]") ?? next?.querySelector("[role=radio]")
    ;(target ?? fallbackFocus?.current)?.focus()
    setRefocus(null)
  }, [values]) // eslint-disable-line react-hooks/exhaustive-deps -- once the rows have changed
  return (
    <div ref={list} id={id} role="radiogroup" aria-label={title} className="flex min-h-0 flex-col overflow-y-auto p-2">
      {items.length === 0 && <div className="px-2 py-1.5 text-sm text-muted">{empty}</div>}
      {items.map((item, index) => {
        const checked = item.value === value
        return (
          <div
            key={item.value}
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
                className="grid w-full min-w-0 grid-cols-[1rem_1fr] items-start gap-x-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus aria-checked:font-medium"
              >
                <span className="pt-0.5 text-accent">{checked && <Icon name="check" size={14} />}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 [overflow-wrap:anywhere]">
                  <span className="min-w-0">{item.label}</span>
                  {item.badge}
                </span>
                {item.detail && (
                  <span className="col-start-2 text-xs font-normal text-muted [overflow-wrap:anywhere]">
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
                  setRefocus({ index, value: item.value })
                  item.action!.onClick()
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

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
    <div className="border-b border-border pb-2">
      <Switch
        description={
          <span className="block text-xs">
            {`Picking a ${kind} here changes it for ${lock.locked ? "this chat only" : "every chat"}.`}
          </span>
        }
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
      </Switch>
    </div>
  )
}
