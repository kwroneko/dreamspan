// A picker of several values: the chosen ones as chips, each removable, and a list to add
// more from, with a search above it when the list is long. An item's `description` explains
// it: a screen reader reads it as the item's description, and the list shows the highlighted
// item's (hovered, or reached with the arrow keys) at its foot, so it never covers a row.
import { Combobox } from "@base-ui/react/combobox"
import { useId, useRef, useState } from "react"
import { Icon } from "./Icon.tsx"

export interface MultiSelectItem<Value extends string> {
  readonly value: Value
  readonly label: string
  /** What choosing it means, when the label alone doesn't say. */
  readonly description?: string | undefined
  /** Shown set apart (a choice no longer on offer, kept until it's removed). */
  readonly unavailable?: boolean | undefined
}

/** How many items a list has before it gets a search. */
const SEARCH_FROM = 8

/** Explanations under each label on phones and touch screens; at the list's foot otherwise. */
const INLINE = "max-sm:block pointer-coarse:block"
const FOOT = "max-sm:hidden pointer-coarse:hidden"

/** A multiple-choice picker. Use inside a `Field`, which names its button and search. */
export function MultiSelect<Value extends string>({
  items,
  value,
  onValueChange,
  addLabel,
  chosenLabel,
  listLabel,
  minimum = 0,
  explanation
}: {
  items: ReadonlyArray<MultiSelectItem<Value>>
  value: ReadonlyArray<Value>
  onValueChange: (value: ReadonlyArray<Value>) => void
  /** The text of the button that opens the list (its name is the `Field` label): "Add". */
  addLabel: string
  /** What the chips are, for a screen reader: "Chosen characters". */
  chosenLabel: string
  /** What the list is: "Choose characters". */
  listLabel: string
  /** The fewest it keeps: a chip can't be removed past it. */
  minimum?: number
  /** What the list as a whole means, at its foot while no item is highlighted. */
  explanation?: string | undefined
}) {
  const chips = useRef<HTMLDivElement>(null)
  const [highlighted, setHighlighted] = useState<MultiSelectItem<Value> | undefined>(undefined)
  const chosen = value.flatMap((v) => items.find((item) => item.value === v) ?? [])
  const searchable = items.length > SEARCH_FROM
  const removable = chosen.length > minimum
  const descriptions = useId()
  return (
    <Combobox.Root
      multiple
      items={items as Array<MultiSelectItem<Value>>}
      value={chosen}
      onValueChange={(next) => {
        if (next.length >= minimum) onValueChange(next.map((item) => item.value))
      }}
      isItemEqualToValue={(item, current) => item.value === current.value}
      itemToStringLabel={(item) => item.label}
      onItemHighlighted={(item) => setHighlighted(item)}
      onOpenChange={(open) => {
        if (!open) setHighlighted(undefined)
      }}
    >
      <Combobox.Chips
        ref={chips}
        aria-label={chosenLabel}
        data-layout-audit-ignore="inset: Chips and Add share this field's border and compact internal padding"
        className="flex min-h-9 w-full min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-1.5 py-1 shadow-xs focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/40"
      >
        <Combobox.Value>
          {(current: Array<MultiSelectItem<Value>>) =>
            current.map((item) => (
              <Combobox.Chip
                key={item.value}
                aria-label={item.label}
                className={`flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full border pr-0.5 pl-2.5 text-sm outline-none data-highlighted:ring-2 data-highlighted:ring-focus/40 ${
                  item.unavailable
                    ? "border-dashed border-border text-muted"
                    : "border-border bg-surface-raised text-text"
                }`}
              >
                <span className="truncate">{item.label}</span>
                {removable ? (
                  <Combobox.ChipRemove
                    aria-label={`Remove ${item.label}`}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-text"
                  >
                    <Icon name="close" />
                  </Combobox.ChipRemove>
                ) : (
                  <span className="w-1.5" aria-hidden="true" />
                )}
              </Combobox.Chip>
            ))
          }
        </Combobox.Value>
        <Combobox.Trigger className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-sm text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/40">
          <Icon name="plus" />
          {addLabel}
        </Combobox.Trigger>
      </Combobox.Chips>
      <Combobox.Portal>
        <Combobox.Positioner
          data-layout-overlay="Choices float above the field"
          className="z-50 outline-none"
          sideOffset={4}
          anchor={chips}
          align="start"
        >
          <Combobox.Popup
            aria-label={listLabel}
            className="flex max-h-[min(var(--available-height),24rem)] w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] flex-col rounded-md border border-border bg-surface text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            {searchable && (
              <div className="border-b border-border p-1.5">
                <Combobox.Input
                  placeholder="Search"
                  className="h-8 w-full min-w-0 rounded-sm border border-border bg-surface px-2 text-base text-text outline-none placeholder:text-muted focus-visible:border-focus sm:text-sm"
                />
              </div>
            )}
            <Combobox.Empty className="px-3 py-2 text-sm text-muted empty:hidden">Nothing matches.</Combobox.Empty>
            <Combobox.List className="min-h-0 flex-1 overflow-y-auto p-1 empty:hidden">
              {(item: MultiSelectItem<Value>) => (
                <Combobox.Item
                  key={item.value}
                  value={item}
                  {...(item.description ? { "aria-describedby": `${descriptions}-${item.value}` } : {})}
                  className="grid grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1.5 pr-4 pl-2 text-sm outline-none select-none data-highlighted:bg-surface-raised"
                >
                  <Combobox.ItemIndicator className="col-start-1 text-accent">
                    <Icon name="check" />
                  </Combobox.ItemIndicator>
                  <span className="col-start-2 flex min-w-0 flex-col">
                    <span className={`truncate ${item.unavailable ? "text-muted" : ""}`}>{item.label}</span>
                    {item.description && (
                      <>
                        <span id={`${descriptions}-${item.value}`} hidden>
                          {item.description}
                        </span>
                        {/* No hover on a touch screen, and no room on a phone: under the label there. */}
                        <span aria-hidden="true" className={`hidden pt-0.5 text-xs text-muted ${INLINE}`}>
                          {item.description}
                        </span>
                      </>
                    )}
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
            {/* The highlighted item's explanation, else the whole list's; a screen reader has the item's description. */}
            {(highlighted?.description ?? explanation) && (
              <p
                aria-hidden="true"
                data-explanation=""
                className={`min-h-[3.25rem] border-t border-border px-3 py-1.5 text-xs text-muted ${FOOT}`}
              >
                {highlighted?.description ?? explanation}
              </p>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
