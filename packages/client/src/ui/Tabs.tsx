// Tabs: arrow keys move between them, and each panel is labelled by its tab.
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import type { ReactNode } from "react"
import { Tooltip } from "./Tooltip.tsx"

export function Tabs<Value extends string>({
  tabs,
  value,
  onValueChange,
  onPointerActivate,
  label,
  fill = false,
  keepMounted = false,
  wrap = false,
  end
}: {
  tabs: ReadonlyArray<{
    readonly value: Value
    readonly label: string
    readonly panel: ReactNode
    /** What the tab holds, in a tooltip on hover and focus. */
    readonly description?: string | undefined
  }>
  value: Value
  onValueChange: (value: Value) => void
  /** After a pointer clicks any tab, including the active one; keyboard focus stays on tabs. */
  onPointerActivate?: ((value: Value) => void) | undefined
  label: string
  /** Fills its container's height, the open panel scrolling inside it; the tabs wrap when narrow. */
  fill?: boolean | undefined
  /** Hidden panels stay mounted, keeping their state: text being typed, say. */
  keepMounted?: boolean | undefined
  /** The tabs wrap onto a second row rather than running out of a narrow column. */
  wrap?: boolean | undefined
  /** Beside the tabs, at the end of their row: a close button, say. */
  end?: ReactNode
}) {
  const list = (
    <BaseTabs.List
      aria-label={label}
      className={
        fill
          ? "flex min-w-0 flex-1 flex-wrap gap-0.5"
          : `flex gap-1 border-b border-border ${wrap ? "flex-wrap gap-y-0" : ""}`
      }
    >
      {tabs.map((tab) => {
        const button = (
          <BaseTabs.Tab
            data-layout-audit-ignore="inset: Tabs meet their panel divider"
            key={tab.value}
            value={tab.value}
            onClick={(event) => {
              if (event.detail > 0) onPointerActivate?.(tab.value)
            }}
            {...(tab.description ? {} : { title: tab.label })}
            // A long label (a card's full name) is cut short rather than running out of the panel.
            className={`${fill ? "max-w-56 min-w-0 shrink-0 truncate px-1.5" : wrap ? "-mb-px px-2" : "-mb-px px-3"} rounded-t-md border-b-2 border-transparent py-1.5 text-sm whitespace-nowrap text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-active:border-accent data-active:text-text`}
          >
            {tab.label}
          </BaseTabs.Tab>
        )
        // What the tab holds, on hover and keyboard focus.
        return tab.description ? (
          <Tooltip key={tab.value} label={tab.description}>
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
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
          className={`min-h-0 outline-none ${fill ? "flex-1 overflow-y-auto px-4 py-4" : ""}`}
        >
          {tab.panel}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  )
}
