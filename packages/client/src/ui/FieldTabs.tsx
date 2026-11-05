// Two or more views of one field as compact tabs at the end of its label's row (DESIGN §4.2: a
// field a note replaces, "As replaced" and "Original"). The field under them is the tab panel:
// it carries `panelProps`. Arrow keys move between the tabs, as in ui/Tabs.
import { type KeyboardEvent, useId, useRef } from "react"
import { Tooltip } from "./Tooltip.tsx"

export interface FieldTab<Value extends string> {
  readonly value: Value
  readonly label: string
  /** What the tab shows, on hover and focus. */
  readonly description: string
}

export function useFieldTabs() {
  const id = useId()
  return {
    tabId: (value: string) => `${id}-tab-${value}`,
    panelId: `${id}-panel`
  }
}

export function FieldTabs<Value extends string>({
  label,
  tabs,
  value,
  onValueChange,
  ids
}: {
  label: string
  tabs: ReadonlyArray<FieldTab<Value>>
  value: Value
  onValueChange: (value: Value) => void
  ids: ReturnType<typeof useFieldTabs>
}) {
  const row = useRef<HTMLDivElement>(null)
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]!
    onValueChange(next.value)
    row.current?.querySelector<HTMLElement>(`#${CSS.escape(ids.tabId(next.value))}`)?.focus()
  }
  return (
    <div
      ref={row}
      role="tablist"
      aria-label={label}
      data-layout-audit-ignore="inset: Joined field tabs share a single outer border"
      className="inline-flex w-fit shrink-0 rounded-md border border-border bg-surface p-0.5"
    >
      {tabs.map((tab, index) => (
        <Tooltip key={tab.value} label={tab.description}>
          <button
            type="button"
            role="tab"
            id={ids.tabId(tab.value)}
            aria-selected={tab.value === value}
            aria-controls={ids.panelId}
            tabIndex={tab.value === value ? 0 : -1}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(event) => move(event, index)}
            className="inline-flex h-6 items-center rounded-[5px] px-2 text-xs whitespace-nowrap text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus aria-selected:bg-surface-raised aria-selected:font-medium aria-selected:text-text max-sm:h-8"
          >
            {tab.label}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
