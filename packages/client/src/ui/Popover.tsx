// A panel anchored to its trigger. Base UI moves focus into it, closes it on Escape or an
// outside click and returns focus to the trigger.
import { Button as BaseButton } from "@base-ui/react/button"
import { Popover as BasePopover } from "@base-ui/react/popover"
import { useRef, type ReactNode, type RefObject } from "react"
import { buttonClass } from "./Button.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { WindowClose } from "./WindowClose.tsx"
import { useAway } from "./away.ts"

export function Popover({
  open,
  onOpenChange,
  trigger,
  triggerLabel,
  triggerDisabled = false,
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
  /** Unavailable triggers stay in place and keep their explanation on hover and focus. */
  triggerDisabled?: boolean
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
  const content = useRef<HTMLDivElement>(null)
  const focusOnOpen = () =>
    [
      ...(content.current?.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]") ?? [])
    ].find(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(":disabled, [data-window-close]") &&
        !element.closest("[hidden], [inert]") &&
        element.getClientRects().length > 0
    ) ?? true
  const away = useAway()
  const button = (
    <BasePopover.Trigger
      aria-label={triggerLabel}
      disabled={triggerDisabled}
      render={<BaseButton focusableWhenDisabled />}
      className={`${triggerClassName} data-disabled:pointer-events-auto! data-disabled:opacity-40`}
    >
      {trigger}
    </BasePopover.Trigger>
  )
  return (
    <BasePopover.Root open={open && !away} onOpenChange={(next) => onOpenChange(next)}>
      {hint === undefined ? (
        button
      ) : (
        <Tooltip label={hint} side={hintSide}>
          {button}
        </Tooltip>
      )}
      <BasePopover.Portal keepMounted={keepMounted}>
        <BasePopover.Positioner
          data-layout-overlay="Popover floats above the page"
          className="z-50 outline-none"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
        >
          <BasePopover.Popup
            ref={content}
            initialFocus={initialFocus ?? focusOnOpen}
            className={`flex ${wide ? "max-h-[min(36rem,var(--available-height))] w-[min(30rem,calc(100vw-2rem))]" : "max-h-[min(28rem,var(--available-height))] w-[min(22rem,calc(100vw-2rem))]"} origin-[var(--transform-origin)] flex-col gap-2 overflow-hidden rounded-lg border border-border bg-surface p-3 text-text shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none`}
          >
            <div className="flex shrink-0 items-start gap-3">
              <BasePopover.Title className="min-w-0 flex-1 text-sm font-semibold [overflow-wrap:anywhere]">
                {title}
              </BasePopover.Title>
              <WindowClose onClick={() => onOpenChange(false)} />
            </div>
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
