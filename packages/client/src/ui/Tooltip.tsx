// Tooltips, and the icon buttons that carry them. A tooltip repeats a control's accessible
// name for sighted mouse and keyboard users; it never holds the only copy of anything.
import { Button as BaseButton } from "@base-ui/react/button"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import type { ComponentProps, ReactElement, ReactNode } from "react"
import { Button, tooltipPopupClass } from "./Button.tsx"
import { Icon, type IconName } from "./Icon.tsx"

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
  `inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors select-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40 data-popup-open:bg-hover data-popup-open:text-text ${
    tone === "danger" ? "text-muted hover:text-danger" : "text-muted hover:text-text"
  }`

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
 * An icon button that toggles (`pressed`): label names it, hint explains the next click. Disabled,
 * it stays focusable and hoverable, so its tooltip can still say why it can't be used.
 * `className` places it and sets when it shows.
 */
export function ToggleIconButton({
  label,
  icon,
  pressed,
  hint,
  disabled = false,
  className = "",
  onClick
}: {
  label: string
  icon: IconName
  pressed: boolean
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
        className={`inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface shadow-sm outline-none transition-opacity select-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus ${
          pressed ? "text-text" : "text-muted"
        } ${className}`}
      >
        <Icon name={icon} />
      </BaseButton>
    </Tooltip>
  )
}
