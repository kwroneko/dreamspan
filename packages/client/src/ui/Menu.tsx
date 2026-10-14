// A list of actions behind a button: arrow keys move through them, Escape closes it and
// returns focus to the button.
import { Menu as BaseMenu } from "@base-ui/react/menu"
import type { ReactNode } from "react"
import { buttonClass } from "./Button.tsx"
import { Tooltip } from "./Tooltip.tsx"

export type MenuItem =
  | { readonly label: string; readonly onSelect: () => void; readonly tone?: "danger" }
  | { readonly label: string; readonly checked: boolean; readonly onCheckedChange: (checked: boolean) => void }

const item =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-surface-raised data-disabled:opacity-50"

export function Menu({
  label,
  trigger,
  items
}: {
  /** The button's accessible name. */
  label: string
  trigger: ReactNode
  items: ReadonlyArray<MenuItem>
}) {
  return (
    <BaseMenu.Root>
      <Tooltip label={label}>
        <BaseMenu.Trigger aria-label={label} className={`${buttonClass("ghost")} h-8! w-8 px-0!`}>
          {trigger}
        </BaseMenu.Trigger>
      </Tooltip>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-50 outline-none" sideOffset={4} align="end">
          <BaseMenu.Popup className="flex min-w-48 origin-[var(--transform-origin)] flex-col rounded-lg border border-border bg-surface p-1 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none">
            {items.map((entry) =>
              "checked" in entry ? (
                <BaseMenu.CheckboxItem
                  key={entry.label}
                  checked={entry.checked}
                  onCheckedChange={(checked) => entry.onCheckedChange(checked)}
                  closeOnClick
                  className={item}
                >
                  <span aria-hidden="true" className="inline-flex w-4 justify-center text-accent">
                    {entry.checked ? "✓" : ""}
                  </span>
                  {entry.label}
                </BaseMenu.CheckboxItem>
              ) : (
                <BaseMenu.Item
                  key={entry.label}
                  onClick={() => entry.onSelect()}
                  className={`${item} ${entry.tone === "danger" ? "text-danger" : ""}`}
                >
                  <span aria-hidden="true" className="inline-flex w-4" />
                  {entry.label}
                </BaseMenu.Item>
              )
            )}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}
