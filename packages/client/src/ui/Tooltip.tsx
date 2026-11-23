// Tooltips, and the icon buttons that carry them. A tooltip repeats a control's accessible
// name for sighted mouse and keyboard users; it never holds the only copy of anything.
import { Button as BaseButton } from "@base-ui/react/button"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import type { ComponentProps, ReactElement, ReactNode } from "react"
import { Button, tooltipPopupClass } from "./Button.tsx"
import { Icon, type IconName } from "./Icon.tsx"
import { linkMenuProps } from "./linkMenuState.ts"
import { openOnPlainClick } from "./links.ts"

/** Shares one delay among the tooltips inside, so moving along a toolbar shows each at once. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={350} closeDelay={0}>
      {children}
    </BaseTooltip.Provider>
  )
}

/**
 * Attaches a tooltip to `children`, which renders the trigger. Props given to the tooltip
 * itself (a menu trigger composing it, say) go on to the trigger.
 */
export function Tooltip({
  label,
  children,
  side = "top",
  followCursor = false,
  enabled = true,
  ...props
}: {
  label: ReactNode
  children: ReactElement
  side?: "top" | "bottom" | "left" | "right"
  /** Placed at the pointer's height: for a trigger taller than the screen, as a rail's bar can be. */
  followCursor?: boolean
  /** False when the full text already fits in its trigger. */
  enabled?: boolean
} & Omit<ComponentProps<typeof BaseTooltip.Trigger>, "render" | "children">) {
  return (
    <BaseTooltip.Root disabled={!enabled} {...(followCursor ? { trackCursorAxis: "y" as const } : {})}>
      <BaseTooltip.Trigger {...props} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          data-layout-overlay="Tooltip floats above the page"
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="pointer-events-none z-50"
        >
          <BaseTooltip.Popup className={tooltipPopupClass}>{label}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

export const iconButtonClass = (tone: "muted" | "danger" = "muted") =>
  `inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors select-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40 data-disabled:opacity-40 data-popup-open:bg-hover data-popup-open:text-text ${
    tone === "danger" ? "text-muted hover:text-danger" : "text-muted hover:text-text"
  }`

/**
 * An icon button laid over a picture (a tile's star, Open beside, pin): its backing stays
 * opaque while hovered and while its tooltip is open, where `hover:bg-hover` and
 * `data-popup-open:bg-hover` would let a dark picture swallow the icon.
 */
const OVER_PICTURE = "bg-surface/85 hover:bg-surface/85 data-popup-open:bg-surface/85"
/**
 * A toggle over a tile's picture (a character's star and archive, a group's pin): one backing,
 * `OVER_PICTURE`, on the button itself, never on a wrapper. Off, it shows only while its
 * `tile-toggle-surface` is hovered or holds focus, and takes no room meanwhile beyond its own
 * corner (styles.css); on, and on touch screens, it stays shown.
 */
export const PICTURE_TOGGLE = `tile-toggle ${OVER_PICTURE}`

/** A button that's just an icon: `label` is its accessible name and its tooltip. */
export function IconButton({
  label,
  hint,
  icon,
  tone = "muted",
  filled = false,
  className = "",
  ...props
}: { label: string; hint?: ReactNode; icon: IconName; tone?: "muted" | "danger"; filled?: boolean } & Omit<
  ComponentProps<typeof BaseButton>,
  "children" | "aria-label"
>) {
  return (
    <Tooltip label={hint ?? label}>
      <BaseButton aria-label={label} className={`${iconButtonClass(tone)} ${className}`} {...props}>
        <Icon name={icon} filled={filled} />
      </BaseButton>
    </Tooltip>
  )
}

/**
 * An `IconButton` that's a link (owner, 2026-11-05: what opens in the center column can open in
 * a new browser tab): a plain click runs `onOpen`, a middle click is the browser's, and a
 * right-click shows its open menu (LinkMenu.tsx).
 */
export function IconLink({
  label,
  hint,
  icon,
  href,
  onOpen,
  disabled = false,
  className = ""
}: {
  label: string
  hint?: ReactNode
  icon: IconName
  href: string
  onOpen: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <Tooltip label={hint ?? label}>
      <a
        {...(disabled ? { "aria-disabled": true, role: "link" } : { href })}
        aria-label={label}
        {...linkMenuProps}
        className={`${iconButtonClass()} ${disabled ? "opacity-50" : ""} ${className}`}
        onClick={(event) => {
          if (disabled) return event.preventDefault()
          openOnPlainClick(onOpen)(event)
        }}
      >
        <Icon name={icon} />
      </a>
    </Tooltip>
  )
}

/**
 * A square `Button` (its variants, `pending`) showing only an icon given as children: `label`
 * is its accessible name, and its tooltip unless `hint` is given.
 */
export function SquareIconButton({
  label,
  hint,
  children,
  className = "",
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label"> & { label: string; hint?: ReactNode }) {
  return (
    <Tooltip label={hint ?? label}>
      <Button aria-label={label} className={`w-9 px-0! ${className}`} {...props}>
        {children}
      </Button>
    </Tooltip>
  )
}

/**
 * A pressed toggle (owner, 2026-11-20: a pinned pin "looks identical to the unpinned one"): accent
 * icon, filled, on an accent wash and edge. The wash is a gradient over the opaque surface, so a
 * toggle over a picture keeps its backing.
 */
const PRESSED = "border-accent/60 bg-linear-to-b from-accent/15 to-accent/15 text-accent"

/**
 * An icon button that toggles (`pressed`): label names it, hint explains the next click. Disabled,
 * it stays focusable and hoverable, so its tooltip can still say why it can't be used.
 * `className` places it and sets when it shows. Without `pressed` it's a plain action in the
 * same shape (a tile's corner button, `tile-action`). `quiet` drops the frame for a toggle
 * repeated on every row of a list (a model's pin): off, a muted icon; pressed, the same accent
 * filled icon as the framed toggle, without the wash and edge.
 */
export function ToggleIconButton({
  label,
  icon,
  pressed,
  hint,
  disabled = false,
  className = "",
  fillWhenPressed = true,
  quiet = false,
  onClick
}: {
  label: string
  icon: IconName
  pressed?: boolean | undefined
  /** False for an icon drawn as open strokes (an eye), which a fill would blot. */
  fillWhenPressed?: boolean
  quiet?: boolean
  hint?: ReactNode
  disabled?: boolean
  className?: string
  onClick: () => void
}) {
  return (
    <Tooltip label={hint ?? label}>
      <BaseButton
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        focusableWhenDisabled
        onClick={onClick}
        className={`inline-flex size-8 items-center justify-center rounded-md outline-none transition-opacity select-none focus-visible:ring-2 focus-visible:ring-focus ${
          quiet
            ? `shrink-0 hover:bg-hover ${pressed ? "text-accent" : "text-muted hover:text-text"}`
            : `border bg-surface shadow-sm ${pressed ? PRESSED : "border-border text-muted hover:text-text"}`
        } ${className}`}
      >
        <Icon name={icon} filled={pressed === true && fillWhenPressed} />
      </BaseButton>
    </Tooltip>
  )
}
