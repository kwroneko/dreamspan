// Tooltips, and the icon buttons that carry them. A tooltip repeats a control's accessible
// name for sighted mouse and keyboard users; it never holds the only copy of anything.
import { Button as BaseButton } from "@base-ui/react/button"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import type { ComponentProps, ReactElement, ReactNode } from "react"
import { Button } from "./Button.tsx"
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
  ...props
}: { label: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" } & Omit<
  ComponentProps<typeof BaseTooltip.Trigger>,
  "render" | "children"
>) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger {...props} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup className="max-w-72 origin-[var(--transform-origin)] rounded-md bg-text px-2 py-1 text-xs text-canvas shadow-md transition-[scale,opacity] duration-100 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

export const iconButtonClass = (tone: "muted" | "danger" = "muted") =>
  `inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors select-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40 data-popup-open:bg-surface-raised data-popup-open:text-text ${
    tone === "danger" ? "text-muted hover:text-danger" : "text-muted hover:text-text"
  }`

/** A button that's just an icon: `label` is its accessible name and its tooltip. */
export function IconButton({
  label,
  icon,
  tone = "muted",
  className = "",
  ...props
}: { label: string; icon: IconName; tone?: "muted" | "danger" } & Omit<
  ComponentProps<typeof BaseButton>,
  "children" | "aria-label"
>) {
  return (
    <Tooltip label={label}>
      <BaseButton aria-label={label} className={`${iconButtonClass(tone)} ${className}`} {...props}>
        <Icon name={icon} />
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
