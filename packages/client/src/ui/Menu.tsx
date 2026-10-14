// A menu of actions on a trigger. Base UI carries the keyboard handling, focus and
// dismissal; this layer carries the look. Items are plain actions, links, or a choice of one.
import { Menu as BaseMenu } from "@base-ui/react/menu"
import type { ComponentProps, ReactElement, ReactNode } from "react"
import { buttonClass } from "./Button.tsx"
import { Icon, type IconName } from "./Icon.tsx"
import { Tooltip } from "./Tooltip.tsx"

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "end",
  label,
  onOpenChange
}: {
  /** The element that opens it, usually a button; it receives the trigger's props. */
  trigger: ReactElement
  children: ReactNode
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  /** An accessible name for the list, when the trigger's text doesn't say what it holds. */
  label?: string
  /** Told when it opens and closes: to read what it lists, say. */
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <BaseMenu.Root modal={false} {...(onOpenChange ? { onOpenChange: (open: boolean) => onOpenChange(open) } : {})}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-50 outline-none" side={side} align={align} sideOffset={4}>
          <BaseMenu.Popup
            aria-label={label}
            className="max-h-[min(28rem,var(--available-height))] max-w-[min(22rem,calc(100vw-1rem))] min-w-48 origin-[var(--transform-origin)] overflow-y-auto rounded-md border border-border bg-surface p-1 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

const itemClass = (tone: "default" | "danger") =>
  `flex min-h-9 cursor-default items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-raised ${
    tone === "danger" ? "text-danger" : ""
  }`

export function MenuItem({
  icon,
  tone = "default",
  children,
  ...props
}: { icon?: IconName; tone?: "default" | "danger"; children: ReactNode } & Omit<
  ComponentProps<typeof BaseMenu.Item>,
  "children" | "className"
>) {
  return (
    <BaseMenu.Item className={itemClass(tone)} {...props}>
      {icon ? <Icon name={icon} className="text-muted" /> : <span className="w-4" />}
      <span className="min-w-0 flex-1">{children}</span>
    </BaseMenu.Item>
  )
}

/** An item that navigates: `render` is the link (a router `Link`, say). */
export function MenuLinkItem({
  icon,
  children,
  render
}: {
  icon?: IconName
  children: ReactNode
  render: ReactElement
}) {
  return (
    <BaseMenu.LinkItem className={itemClass("default")} render={render} closeOnClick>
      {icon ? <Icon name={icon} className="text-muted" /> : <span className="w-4" />}
      <span className="min-w-0 flex-1">{children}</span>
    </BaseMenu.LinkItem>
  )
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="mx-1 my-1 h-px bg-border" />
}

export function MenuGroup({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted">{label}</BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  )
}

/** A choice of one among `children` (`MenuRadioItem`s). */
export function MenuRadioGroup<Value>({
  value,
  onValueChange,
  children
}: {
  value: Value
  onValueChange: (value: Value) => void
  children: ReactNode
}) {
  return (
    <BaseMenu.RadioGroup value={value} onValueChange={(next) => onValueChange(next as Value)}>
      {children}
    </BaseMenu.RadioGroup>
  )
}

export function MenuRadioItem({ value, children }: { value: unknown; children: ReactNode }) {
  return (
    <BaseMenu.RadioItem
      value={value}
      closeOnClick
      className="grid min-h-9 cursor-default grid-cols-[1rem_1fr] items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-surface-raised"
    >
      <BaseMenu.RadioItemIndicator className="col-start-1 text-accent">
        <Icon name="check" />
      </BaseMenu.RadioItemIndicator>
      <span className="col-start-2 min-w-0">{children}</span>
    </BaseMenu.RadioItem>
  )
}

export type ActionMenuItem =
  | { readonly label: string; readonly onSelect: () => void; readonly tone?: "danger" }
  | { readonly label: string; readonly checked: boolean; readonly onCheckedChange: (checked: boolean) => void }

/** A ghost icon button (named by `label`, with it as its tooltip) opening a list of actions and switches. */
export function ActionMenu({
  label,
  trigger,
  items
}: {
  label: string
  trigger: ReactNode
  items: ReadonlyArray<ActionMenuItem>
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
          <BaseMenu.Popup className="flex min-w-48 origin-[var(--transform-origin)] flex-col rounded-md border border-border bg-surface p-1 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none">
            {items.map((entry) =>
              "checked" in entry ? (
                <BaseMenu.CheckboxItem
                  key={entry.label}
                  checked={entry.checked}
                  onCheckedChange={(checked) => entry.onCheckedChange(checked)}
                  closeOnClick
                  className={itemClass("default")}
                >
                  <span aria-hidden="true" className="inline-flex w-4 justify-center text-accent">
                    {entry.checked ? <Icon name="check" /> : null}
                  </span>
                  {entry.label}
                </BaseMenu.CheckboxItem>
              ) : (
                <BaseMenu.Item
                  key={entry.label}
                  onClick={() => entry.onSelect()}
                  className={itemClass(entry.tone ?? "default")}
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
