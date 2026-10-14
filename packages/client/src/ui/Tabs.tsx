// Tabs: arrow keys move between them, and each panel is labelled by its tab.
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import type { ReactNode } from "react"

export function Tabs<Value extends string>({
  tabs,
  value,
  onValueChange,
  label,
  fill = false,
  keepMounted = false,
  end
}: {
  tabs: ReadonlyArray<{ readonly value: Value; readonly label: string; readonly panel: ReactNode }>
  value: Value
  onValueChange: (value: Value) => void
  label: string
  /** Fills its container's height, the open panel scrolling inside it; the tabs wrap when narrow. */
  fill?: boolean | undefined
  /** Hidden panels stay mounted, keeping their state: text being typed, say. */
  keepMounted?: boolean | undefined
  /** Beside the tabs, at the end of their row: a close button, say. */
  end?: ReactNode
}) {
  const list = (
    <BaseTabs.List
      aria-label={label}
      className={fill ? "flex min-w-0 flex-1 flex-wrap gap-0.5" : "flex gap-1 border-b border-border"}
    >
      {tabs.map((tab) => (
        <BaseTabs.Tab
          key={tab.value}
          value={tab.value}
          className={`${fill ? "shrink-0 px-1.5" : "-mb-px px-3"} rounded-t-md border-b-2 border-transparent py-1.5 text-sm whitespace-nowrap text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-active:border-accent data-active:text-text`}
        >
          {tab.label}
        </BaseTabs.Tab>
      ))}
    </BaseTabs.List>
  )
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className={`flex min-h-0 flex-col ${fill ? "flex-1" : "gap-2"}`}
    >
      {fill || end ? (
        <div className={`flex items-end gap-1 ${fill ? "border-b border-border px-2" : ""}`}>
          {list}
          {end}
        </div>
      ) : (
        list
      )}
      {tabs.map((tab) => (
        <BaseTabs.Panel
          key={tab.value}
          value={tab.value}
          keepMounted={keepMounted}
          className={`min-h-0 overflow-y-auto outline-none ${fill ? "flex-1 px-4 py-4" : ""}`}
        >
          {tab.panel}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  )
}
