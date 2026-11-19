// Pickers. An item's `description` explains it beside the highlighted option, or under its
// label on touch screens and narrow windows (`Explanation.tsx`), so the label can stay short.
import { Select as BaseSelect } from "@base-ui/react/select"
import { Fragment, useState, type ReactNode } from "react"
import { HighlightExplanation, useItemExplanation } from "./Explanation.tsx"

export interface SelectItem<Value> {
  readonly value: Value
  readonly label: string
  /** What choosing it means, when the label alone doesn't say. */
  readonly description?: string | undefined
  /** A line before it: it starts a different kind of choice (a card source after the filters). */
  readonly separatorBefore?: boolean
  /** Listed but not choosable; its description says why. */
  readonly disabled?: boolean
}

function SelectOption<Value>({ item }: { item: SelectItem<Value> }) {
  const explanation = useItemExplanation(item.description)
  return (
    <BaseSelect.Item
      value={item.value}
      disabled={item.disabled ?? false}
      {...explanation.describedBy}
      className="grid grid-cols-[1rem_1fr] items-center gap-x-2 rounded-sm py-1.5 pr-4 pl-2 text-sm outline-none select-none data-disabled:opacity-60 data-highlighted:bg-surface-raised"
    >
      <BaseSelect.ItemIndicator className="col-start-1 row-start-1 text-accent">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="m2.5 8.5 4 4 7-9" strokeWidth="1.5" />
        </svg>
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="col-start-2 row-start-1">{item.label}</BaseSelect.ItemText>
      {explanation.parts && <span className="col-start-2 flex flex-col">{explanation.parts}</span>}
    </BaseSelect.Item>
  )
}

/** A single-choice picker. Use inside a `Field` for its label. */
export function Select<Value>({
  items,
  value,
  onValueChange,
  placeholder,
  className = "",
  ariaLabel,
  shown,
  disabled = false,
  mixed = false
}: {
  disabled?: boolean
  /** No value because the values it stands for differ: the placeholder ("Mixed") in italics. */
  mixed?: boolean
  items: ReadonlyArray<SelectItem<Value>>
  value: Value | null
  onValueChange: (value: Value) => void
  placeholder?: string
  className?: string
  /** Its name when no `Field` labels it: a table cell's, say. */
  ariaLabel?: string
  /** What the closed picker shows for a value, when its label is too long for the space. */
  shown?: (value: Value) => ReactNode
}) {
  const [popup, setPopup] = useState<HTMLElement | null>(null)
  return (
    <BaseSelect.Root
      items={items as Array<SelectItem<Value>>}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as Value)
      }}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={`flex h-9 w-full max-w-controls min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-base text-text shadow-xs outline-none select-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 data-disabled:opacity-50 sm:text-sm ${className}`}
      >
        <BaseSelect.Value
          className={`truncate data-placeholder:text-muted ${mixed ? "data-placeholder:italic" : ""}`}
          placeholder={placeholder}
        >
          {shown ? (current: Value | null) => (current === null ? placeholder : shown(current)) : undefined}
        </BaseSelect.Value>
        <BaseSelect.Icon className="text-muted">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M11 10H5l3 3.5zm0-4H5l3-3.5z" />
          </svg>
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          data-layout-overlay="Select list floats above the page"
          className="z-50 outline-none select-none"
          sideOffset={4}
        >
          <BaseSelect.Popup
            ref={setPopup}
            className="max-h-[var(--available-height)] max-w-[min(24rem,calc(100vw-1rem))] min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-md border border-border bg-surface text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            <BaseSelect.List className="p-2">
              {items.map((item) => (
                <Fragment key={String(item.value)}>
                  {item.separatorBefore && <BaseSelect.Separator className="mx-1 my-1 h-px bg-border" />}
                  <SelectOption item={item} />
                </Fragment>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
          <HighlightExplanation popup={popup} />
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
