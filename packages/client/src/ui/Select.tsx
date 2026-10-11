import { Select as BaseSelect } from "@base-ui/react/select"

export interface SelectItem<Value> {
  readonly value: Value
  readonly label: string
}

/** A single-choice picker. Use inside a `Field` for its label. */
export function Select<Value>({
  items,
  value,
  onValueChange,
  placeholder,
  className = ""
}: {
  items: ReadonlyArray<SelectItem<Value>>
  value: Value | null
  onValueChange: (value: Value) => void
  placeholder?: string
  className?: string
}) {
  return (
    <BaseSelect.Root
      items={items as Array<SelectItem<Value>>}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as Value)
      }}
    >
      <BaseSelect.Trigger
        className={`flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-base text-text shadow-xs outline-none select-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 data-disabled:opacity-50 sm:text-sm ${className}`}
      >
        <BaseSelect.Value className="truncate data-placeholder:text-muted" placeholder={placeholder} />
        <BaseSelect.Icon className="text-muted">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M11 10H5l3 3.5zm0-4H5l3-3.5z" />
          </svg>
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50 outline-none select-none" sideOffset={4}>
          <BaseSelect.Popup className="max-h-[var(--available-height)] min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-md border border-border bg-surface p-1 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none">
            <BaseSelect.List>
              {items.map((item) => (
                <BaseSelect.Item
                  key={String(item.value)}
                  value={item.value}
                  className="grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1.5 pr-4 pl-2 text-sm outline-none select-none data-highlighted:bg-surface-raised"
                >
                  <BaseSelect.ItemIndicator className="col-start-1 text-accent">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path d="m2.5 8.5 4 4 7-9" strokeWidth="1.5" />
                    </svg>
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText className="col-start-2">{item.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
