// A menu of actions on a trigger. Base UI carries the keyboard handling, focus and
// dismissal; this layer carries the look. Items are plain actions, links, or a choice of one.
// An item's `description` explains it beside the item while it's highlighted, or under its
// label on touch screens and narrow windows (`Explanation.tsx`), so the label can stay short.
import { Menu as BaseMenu } from "@base-ui/react/menu"
import { type ComponentProps, type ReactElement, type ReactNode, useState } from "react"
import { buttonClass } from "./Button.tsx"
import { HighlightExplanation, useItemExplanation } from "./Explanation.tsx"
import { Icon, type IconName } from "./Icon.tsx"
import { Tooltip } from "./Tooltip.tsx"

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "end",
  label,
  defaultOpen = false,
  onOpenChange
}: {
  /** The element that opens it, usually a button; it receives the trigger's props. */
  trigger: ReactElement
  children: ReactNode
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  /** An accessible name for the list, when the trigger's text doesn't say what it holds. */
  label?: string
  /** Open as it mounts: a menu mounted only once its trigger is first used, as a long list's rows do. */
  defaultOpen?: boolean
  /** Told when it opens and closes: to read what it lists, say. */
  onOpenChange?: (open: boolean) => void
}) {
  const [popup, setPopup] = useState<HTMLElement | null>(null)
  return (
    <BaseMenu.Root
      modal={false}
      defaultOpen={defaultOpen}
      {...(onOpenChange ? { onOpenChange: (open: boolean) => onOpenChange(open) } : {})}
    >
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          className="z-50 outline-none"
          positionMethod="fixed"
          side={side}
          align={align}
          sideOffset={4}
        >
          <BaseMenu.Popup
            ref={setPopup}
            aria-label={label}
            className="max-h-[min(28rem,var(--available-height))] max-w-[min(22rem,calc(100vw-1rem))] min-w-48 origin-[var(--transform-origin)] overflow-y-auto rounded-md border border-border bg-surface p-1 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            {children}
          </BaseMenu.Popup>
          <HighlightExplanation popup={popup} />
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

const itemClass = (tone: "default" | "danger") =>
  `flex min-h-9 items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-raised ${
    tone === "danger" ? "text-danger" : ""
  }`

/** The label, with its explanation's parts under it. */
function ItemText({ children, parts }: { children: ReactNode; parts: ReactNode }) {
  return parts ? (
    <span className="flex min-w-0 flex-1 flex-col">
      <span>{children}</span>
      {parts}
    </span>
  ) : (
    <span className="min-w-0 flex-1">{children}</span>
  )
}

export function MenuItem({
  icon,
  tone = "default",
  description,
  children,
  ...props
}: {
  icon?: IconName
  tone?: "default" | "danger"
  /** What it does, when the label alone doesn't say: shown beside it while it's highlighted. */
  description?: string | undefined
  children: ReactNode
} & Omit<ComponentProps<typeof BaseMenu.Item>, "children" | "className">) {
  const explanation = useItemExplanation(description)
  return (
    <BaseMenu.Item className={itemClass(tone)} {...explanation.describedBy} {...props}>
      {icon ? <Icon name={icon} className="text-muted" /> : <span className="w-4" />}
      <ItemText parts={explanation.parts}>{children}</ItemText>
    </BaseMenu.Item>
  )
}

/** An item that navigates: `render` is the link (a router `Link`, say). */
export function MenuLinkItem({
  icon,
  description,
  children,
  render
}: {
  icon?: IconName
  description?: string | undefined
  children: ReactNode
  render: ReactElement
}) {
  const explanation = useItemExplanation(description)
  return (
    <BaseMenu.LinkItem className={itemClass("default")} render={render} closeOnClick {...explanation.describedBy}>
      {icon ? <Icon name={icon} className="text-muted" /> : <span className="w-4" />}
      <ItemText parts={explanation.parts}>{children}</ItemText>
    </BaseMenu.LinkItem>
  )
}

/** An on/off switch in a menu, ticked when on. */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  disabled,
  description,
  children
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  description?: string | undefined
  children: ReactNode
}) {
  const explanation = useItemExplanation(description)
  return (
    <BaseMenu.CheckboxItem
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      closeOnClick
      {...(disabled ? { disabled } : {})}
      {...explanation.describedBy}
      className={itemClass("default")}
    >
      <BaseMenu.CheckboxItemIndicator keepMounted className="inline-flex w-4 justify-center text-accent">
        {checked ? <Icon name="check" /> : null}
      </BaseMenu.CheckboxItemIndicator>
      <ItemText parts={explanation.parts}>{children}</ItemText>
    </BaseMenu.CheckboxItem>
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

export type ActionMenuItem =
  | {
      readonly label: string
      readonly description?: string
      readonly onSelect: () => void
      readonly tone?: "danger"
    }
  | {
      readonly label: string
      readonly description?: string
      readonly checked: boolean
      readonly onCheckedChange: (checked: boolean) => void
    }

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
  const [popup, setPopup] = useState<HTMLElement | null>(null)
  return (
    <BaseMenu.Root>
      <Tooltip label={label}>
        <BaseMenu.Trigger aria-label={label} className={`${buttonClass("ghost")} h-8! w-8 px-0!`}>
          {trigger}
        </BaseMenu.Trigger>
      </Tooltip>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-50 outline-none" positionMethod="fixed" sideOffset={4} align="end">
          <BaseMenu.Popup
            ref={setPopup}
            className="flex min-w-48 origin-[var(--transform-origin)] flex-col rounded-md border border-border bg-surface p-1 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            {items.map((entry) =>
              "checked" in entry ? (
                <MenuCheckboxItem
                  key={entry.label}
                  checked={entry.checked}
                  onCheckedChange={(checked) => entry.onCheckedChange(checked)}
                  description={entry.description}
                >
                  {entry.label}
                </MenuCheckboxItem>
              ) : (
                <MenuItem
                  key={entry.label}
                  onClick={() => entry.onSelect()}
                  {...(entry.tone ? { tone: entry.tone } : {})}
                  description={entry.description}
                >
                  {entry.label}
                </MenuItem>
              )
            )}
          </BaseMenu.Popup>
          <HighlightExplanation popup={popup} />
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}
