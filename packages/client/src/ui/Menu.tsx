// A menu of actions on a trigger. Base UI carries the keyboard handling, focus and
// dismissal; this layer carries the look. Items are plain actions, links, or a choice of one.
import { Menu as BaseMenu } from "@base-ui/react/menu"
import { useId, type ComponentProps, type ReactElement, type ReactNode } from "react"
import { buttonClass } from "./Button.tsx"
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
  `flex min-h-9 items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-raised ${
    tone === "danger" ? "text-danger" : ""
  }`

export function MenuItem({
  icon,
  tone = "default",
  hint,
  children,
  ...props
}: {
  icon?: IconName
  tone?: "default" | "danger"
  /** What the item does, beside the menu while it's pointed at or focused, so its label can stay short. */
  hint?: ReactNode
  children: ReactNode
} & Omit<ComponentProps<typeof BaseMenu.Item>, "children" | "className">) {
  const item = (
    <BaseMenu.Item className={itemClass(tone)} {...props}>
      {icon ? <Icon name={icon} className="text-muted" /> : <span className="w-4" />}
      <span className="min-w-0 flex-1">{children}</span>
    </BaseMenu.Item>
  )
  return hint ? (
    <Tooltip label={hint} side="right">
      {item}
    </Tooltip>
  ) : (
    item
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

/** An on/off switch in a menu, ticked when on. */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  disabled,
  children
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <BaseMenu.CheckboxItem
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      closeOnClick
      {...(disabled ? { disabled } : {})}
      className={itemClass("default")}
    >
      <BaseMenu.CheckboxItemIndicator keepMounted className="inline-flex w-4 justify-center text-accent">
        {checked ? <Icon name="check" /> : null}
      </BaseMenu.CheckboxItemIndicator>
      <span className="min-w-0 flex-1">{children}</span>
    </BaseMenu.CheckboxItem>
  )
}

/**
 * An action with a switch beside it, in one row: the action is a menu item that runs and
 * closes the menu, the switch a separate checkbox item that toggles and leaves it open (to
 * show the action on the message, say). Arrow keys reach each in turn, and a screen reader
 * hears two items: the action, described by `description`, then the switch by its own name.
 * Both show their explanation in a tooltip at the side, clear of the rows below; on a touch
 * screen the switch is a full-height 44 px target.
 */
export function MenuItemWithCheckbox({
  icon,
  tone = "default",
  label,
  note,
  description,
  disabled = false,
  onSelect,
  link,
  checkbox
}: {
  icon: IconName
  tone?: "default" | "danger"
  label: string
  /** A line under the label: why it can't be used now, say. */
  note?: ReactNode
  /** What it does in full: its tooltip and its accessible description. */
  description: string
  disabled?: boolean
  onSelect?: () => void
  /** Navigates instead: the link element (a router `Link`) the item renders as. */
  link?: ReactElement
  checkbox: {
    readonly checked: boolean
    readonly onCheckedChange: (checked: boolean) => void
    /** Its accessible name, naming the action: "Show Edit on the message". */
    readonly label: string
    readonly description: string
  }
}) {
  const id = useId()
  const content = (
    <>
      <Icon name={icon} className="text-muted" />
      <span className="min-w-0 flex-1">
        {label}
        {note !== undefined && <span className="block text-xs text-muted">{note}</span>}
      </span>
    </>
  )
  const itemClassName = `${itemClass(tone)} min-w-0 flex-1 [@media(pointer:coarse)]:min-h-11`
  return (
    <div role="none" className="flex items-stretch gap-0.5">
      <span id={`${id}-description`} hidden>
        {description}
      </span>
      <span id={`${id}-checkbox`} hidden>
        {checkbox.description}
      </span>
      <Tooltip label={description} side="left">
        {link ? (
          <BaseMenu.LinkItem
            render={link}
            closeOnClick
            label={label}
            aria-describedby={`${id}-description`}
            className={itemClassName}
          >
            {content}
          </BaseMenu.LinkItem>
        ) : (
          <BaseMenu.Item
            label={label}
            disabled={disabled}
            aria-describedby={`${id}-description`}
            className={itemClassName}
            {...(onSelect ? { onClick: () => onSelect() } : {})}
          >
            {content}
          </BaseMenu.Item>
        )}
      </Tooltip>
      <Tooltip label={checkbox.description} side="right">
        <BaseMenu.CheckboxItem
          checked={checkbox.checked}
          onCheckedChange={(next) => checkbox.onCheckedChange(next)}
          closeOnClick={false}
          // Typing a letter goes to the actions, never to the switches beside them.
          label=""
          aria-label={checkbox.label}
          aria-describedby={`${id}-checkbox`}
          className="group/pin flex w-9 shrink-0 items-center justify-center rounded-sm outline-none select-none data-highlighted:bg-surface-raised [@media(pointer:coarse)]:w-11"
        >
          <span
            aria-hidden="true"
            className="flex size-4 items-center justify-center rounded-[4px] border border-border bg-surface text-accent-contrast group-data-checked/pin:border-accent group-data-checked/pin:bg-accent"
          >
            {checkbox.checked && (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor">
                <path d="m2.5 8.5 4 4 7-9" strokeWidth="2" />
              </svg>
            )}
          </span>
        </BaseMenu.CheckboxItem>
      </Tooltip>
    </div>
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
        <BaseMenu.Positioner className="z-50 outline-none" positionMethod="fixed" sideOffset={4} align="end">
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
