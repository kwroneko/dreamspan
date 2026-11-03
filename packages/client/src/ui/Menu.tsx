// A menu of actions on a trigger. Base UI carries the keyboard handling, focus and
// dismissal; this layer carries the look. Items are plain actions, links, or a choice of one.
// An item's `description` explains it beside the item while it's highlighted, or under its
// label on touch screens and narrow windows (`Explanation.tsx`), so the label can stay short.
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu"
import { Menu as BaseMenu } from "@base-ui/react/menu"
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useId,
  useState
} from "react"
import { Button, buttonClass } from "./Button.tsx"
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
  onOpenChange,
  open,
  finalFocus,
  marker,
  hint,
  keepMounted = false
}: {
  /** Keep action components mounted when closed so their dialogs stay open. */
  keepMounted?: boolean
  /** The element that opens it, usually a button; it receives the trigger's props. */
  trigger: ReactElement
  /** What the trigger opens, on hover and focus: an icon-only ⋯ says what's in it. */
  hint?: ReactNode
  children: ReactNode
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
  /** An accessible name for the list, when the trigger's text doesn't say what it holds. */
  label?: string
  /** Open as it mounts: a menu mounted only once its trigger is first used, as a long list's rows do. */
  defaultOpen?: boolean
  /** Told when it opens and closes: to read what it lists, say. */
  onOpenChange?: (open: boolean, reason: string) => void
  /** Controlled: open while true, `onOpenChange` asked for every change. */
  open?: boolean | undefined
  /** Where focus goes when it closes, instead of back to the trigger. */
  finalFocus?: (() => boolean | HTMLElement | null | void) | undefined
  /** `data-menu` on the list, for code that must know focus is in it (an editor's own menu, say). */
  marker?: string | undefined
}) {
  const [popup, setPopup] = useState<HTMLElement | null>(null)
  return (
    <BaseMenu.Root
      modal={false}
      defaultOpen={defaultOpen}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange
        ? { onOpenChange: (next: boolean, details: { reason: string }) => onOpenChange(next, details.reason) }
        : {})}
    >
      {hint ? (
        <Tooltip label={hint}>
          <BaseMenu.Trigger render={trigger} />
        </Tooltip>
      ) : (
        <BaseMenu.Trigger render={trigger} />
      )}
      <BaseMenu.Portal keepMounted={keepMounted}>
        <BaseMenu.Positioner
          data-layout-overlay="Menu floats above the page"
          className="z-50 outline-none"
          positionMethod="fixed"
          sticky
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
        >
          <BaseMenu.Popup
            ref={setPopup}
            aria-label={label}
            data-menu={marker}
            {...(finalFocus ? { finalFocus } : {})}
            className="max-h-[min(28rem,var(--available-height))] max-w-[min(22rem,calc(100vw-1rem))] min-w-48 origin-[var(--transform-origin)] overflow-y-auto rounded-md border border-border bg-surface p-2 text-text shadow-lg outline-none [&:not(:has(.menu-mark))_.menu-slot]:hidden transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            <MenuActionsContext value>{children}</MenuActionsContext>
          </BaseMenu.Popup>
          <HighlightExplanation popup={popup} />
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

const MenuActionsContext = createContext(false)
export const useMenuActions = () => useContext(MenuActionsContext)

/** An existing action shown as a menu item inside a Menu, or a button elsewhere. */
export function MenuAction({
  hint,
  children,
  onClick,
  disabled,
  ...props
}: {
  hint: string
  children: ReactNode
  onClick: () => void
  disabled?: boolean | undefined
  variant?: ComponentProps<typeof Button>["variant"]
  className?: string
  "aria-label"?: string
}) {
  const inMenu = useMenuActions()
  return inMenu ? (
    <MenuItem description={hint} onClick={onClick} disabled={disabled} aria-label={props["aria-label"]}>
      {children}
    </MenuItem>
  ) : (
    <Button hint={hint} onClick={onClick} disabled={disabled} {...props}>
      {children}
    </Button>
  )
}

/** A real submenu: hover, click, Enter and the forward arrow use Base UI's menu handling. */
export function MenuSubmenu({
  label,
  description,
  children
}: {
  label: string
  description: string
  children: ReactNode
}) {
  const [popup, setPopup] = useState<HTMLElement | null>(null)
  const explanation = useItemExplanation(description)
  const [open, setOpen] = useState(false)
  return (
    <BaseMenu.SubmenuRoot open={open} onOpenChange={setOpen}>
      <BaseMenu.SubmenuTrigger
        label={label}
        delay={0}
        closeDelay={200}
        onClick={() => setOpen(true)}
        className={itemClass("default")}
        {...explanation.describedBy}
        data-explain={open ? undefined : description}
      >
        <span className="menu-slot w-4 shrink-0" />
        <ItemText parts={explanation.parts}>{label}</ItemText>
        <Icon name="right" className="shrink-0 text-muted" />
      </BaseMenu.SubmenuTrigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          data-layout-overlay="Submenu floats above its parent menu"
          className="z-50 outline-none"
          positionMethod="fixed"
          sticky
          side="right"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <BaseMenu.Popup
            ref={setPopup}
            aria-label={label}
            className="max-h-[min(28rem,var(--available-height))] max-w-[min(22rem,calc(100vw-1rem))] min-w-48 origin-[var(--transform-origin)] overflow-y-auto rounded-md border border-border bg-surface p-2 text-text shadow-lg outline-none [&:not(:has(.menu-mark))_.menu-slot]:hidden transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
          >
            {children}
          </BaseMenu.Popup>
          <HighlightExplanation popup={popup} />
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.SubmenuRoot>
  )
}

/** A button's alternate actions, opened by right-click or touch long-press. */
export function ContextMenu({
  trigger,
  children,
  label,
  open,
  onOpenChange
}: {
  trigger: ReactElement
  children: ReactNode
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [popup, setPopup] = useState<HTMLElement | null>(null)
  return (
    <BaseContextMenu.Root open={open} onOpenChange={onOpenChange}>
      <BaseContextMenu.Trigger
        render={trigger}
        // A long-press opens while the finger is still down. Suppress the compatibility
        // click on release, which would otherwise dismiss the menu on its own trigger.
        onTouchEnd={(event) => {
          if (open) event.preventDefault()
        }}
      />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner
          data-layout-overlay="Context menu floats above the page"
          className="z-50 outline-none"
          sideOffset={4}
          collisionPadding={8}
        >
          <BaseContextMenu.Popup
            ref={setPopup}
            aria-label={label}
            className="max-h-[var(--available-height)] max-w-[min(22rem,calc(100vw-1rem))] min-w-48 overflow-y-auto rounded-md border border-border bg-surface p-2 text-text shadow-lg outline-none [&:not(:has(.menu-mark))_.menu-slot]:hidden"
          >
            {children}
          </BaseContextMenu.Popup>
          <HighlightExplanation popup={popup} />
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  )
}

/** A single choice in a menu, with the current choice checked. */
export function MenuRadioGroup<Value extends string>({
  value,
  onValueChange,
  items
}: {
  value: Value
  onValueChange: (value: Value) => void
  items: ReadonlyArray<{ value: Value; label: string; description: string }>
}) {
  return (
    <BaseMenu.RadioGroup value={value} onValueChange={onValueChange}>
      {items.map((item) => (
        <MenuRadioItem key={item.value} {...item} />
      ))}
    </BaseMenu.RadioGroup>
  )
}

function MenuRadioItem({ value, label, description }: { value: string; label: string; description: string }) {
  const explanation = useItemExplanation(description)
  return (
    <BaseMenu.RadioItem value={value} closeOnClick className={itemClass("default")} {...explanation.describedBy}>
      <span className="menu-mark inline-flex w-4 shrink-0 justify-center text-accent">
        <BaseMenu.RadioItemIndicator>
          <Icon name="check" />
        </BaseMenu.RadioItemIndicator>
      </span>
      <ItemText parts={explanation.parts}>{label}</ItemText>
    </BaseMenu.RadioItem>
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
      {icon ? <Icon name={icon} className="menu-mark text-muted" /> : <span className="menu-slot w-4 shrink-0" />}
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
      {icon ? <Icon name={icon} className="menu-mark text-muted" /> : <span className="menu-slot w-4 shrink-0" />}
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
      <BaseMenu.CheckboxItemIndicator keepMounted className="menu-mark inline-flex w-4 justify-center text-accent">
        {checked ? <Icon name="check" /> : null}
      </BaseMenu.CheckboxItemIndicator>
      <ItemText parts={explanation.parts}>{children}</ItemText>
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
        <BaseMenu.Positioner
          data-layout-overlay="Menu floats above the page"
          className="z-50 outline-none"
          positionMethod="fixed"
          sticky
          sideOffset={4}
          align="end"
          collisionPadding={8}
        >
          <BaseMenu.Popup
            ref={setPopup}
            className="flex max-h-[min(28rem,var(--available-height))] max-w-[min(22rem,calc(100vw-1rem))] min-w-48 origin-[var(--transform-origin)] flex-col overflow-y-auto rounded-md border border-border bg-surface p-2 text-text shadow-lg outline-none [&:not(:has(.menu-mark))_.menu-slot]:hidden transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
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
