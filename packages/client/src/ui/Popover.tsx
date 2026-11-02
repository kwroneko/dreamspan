// A panel anchored to its trigger. Base UI moves focus into it, closes it on Escape or an
// outside click and returns focus to the trigger.
import { Popover as BasePopover } from "@base-ui/react/popover"
import type { ReactNode, RefObject } from "react"
import { buttonClass } from "./Button.tsx"
import { Tooltip } from "./Tooltip.tsx"

export function Popover({
  open,
  onOpenChange,
  trigger,
  triggerLabel,
  title,
  children,
  triggerClassName = `${buttonClass("secondary")} max-w-full`,
  hint,
  hintSide = "top",
  side = "top",
  align = "start",
  initialFocus,
  wide = false,
  keepMounted = false
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the trigger button shows. */
  trigger: ReactNode
  triggerLabel: string
  title: string
  children: ReactNode
  /** The trigger's look; a secondary button by default. */
  triggerClassName?: string
  /** A tooltip on the trigger, for one that shows only an icon or a name. */
  hint?: ReactNode
  hintSide?: "top" | "bottom"
  side?: "top" | "bottom"
  align?: "start" | "end"
  /** What gets focus as it opens (a search field, say); otherwise the panel's first control. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Wider and taller, for a long list with previews. */
  wide?: boolean
  /** Stays mounted, hidden, while closed: what its controls opened (a dialog, say) stays open. */
  keepMounted?: boolean
}) {
  const button = (
    <BasePopover.Trigger aria-label={triggerLabel} className={triggerClassName}>
      {trigger}
    </BasePopover.Trigger>
  )
  return (
    <BasePopover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      {hint === undefined ? (
        button
      ) : (
        <Tooltip label={hint} side={hintSide}>
          {button}
        </Tooltip>
      )}
      <BasePopover.Portal keepMounted={keepMounted}>
        <BasePopover.Positioner
          className="z-50 outline-none"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
        >
          <BasePopover.Popup
            {...(initialFocus === undefined ? {} : { initialFocus })}
            className={`flex ${wide ? "max-h-[min(36rem,var(--available-height))] w-[min(30rem,calc(100vw-2rem))]" : "max-h-[min(28rem,var(--available-height))] w-[min(22rem,calc(100vw-2rem))]"} origin-[var(--transform-origin)] flex-col gap-2 overflow-hidden rounded-lg border border-border bg-surface p-3 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none`}
          >
            <BasePopover.Title className="text-sm font-semibold">{title}</BasePopover.Title>
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
