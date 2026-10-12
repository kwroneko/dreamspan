// Tabs: arrow keys move between them, and each panel is labelled by its tab.
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import type { ReactNode } from "react"

export function Tabs<Value extends string>({
  tabs,
  value,
  onValueChange,
  label
}: {
  tabs: ReadonlyArray<{ readonly value: Value; readonly label: string; readonly panel: ReactNode }>
  value: Value
  onValueChange: (value: Value) => void
  label: string
}) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className="flex min-h-0 flex-col gap-2"
    >
      <BaseTabs.List aria-label={label} className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <BaseTabs.Tab
            key={tab.value}
            value={tab.value}
            className="-mb-px rounded-t-md border-b-2 border-transparent px-3 py-1.5 text-sm text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-selected:border-accent data-selected:text-text"
          >
            {tab.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {tabs.map((tab) => (
        <BaseTabs.Panel key={tab.value} value={tab.value} className="min-h-0 overflow-y-auto outline-none">
          {tab.panel}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  )
}
