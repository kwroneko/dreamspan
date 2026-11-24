// Feature code imports UI from here, never from Base UI directly (CLIENT-FRAMEWORK.md §8):
// Base UI carries behavior and accessibility, this layer carries the look.
import { Button as BaseButton } from "@base-ui/react/button"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import { type ComponentProps, type ReactNode, useId } from "react"
import { Spinner } from "./Spinner.tsx"
import { linkMenuProps } from "./linkMenuState.ts"
import { openOnPlainClick } from "./links.ts"

type Variant = "primary" | "secondary" | "ghost" | "danger"

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:opacity-90",
  secondary: "bg-surface-raised text-text border border-border hover:bg-surface",
  ghost: "text-muted hover:text-text hover:bg-surface-raised",
  danger: "bg-danger text-danger-contrast hover:opacity-90"
}

/**
 * "chip": a small pill for an action beside a heading (owner, 2026-11-24: "more like a chip").
 * A 12 px icon's box insets its glyph by the same amount on both sides, so with the left padding
 * equal to the gap, edge-to-glyph and glyph-to-text are the same space.
 */
type Size = "default" | "chip"

const sizes: Record<Size, string> = {
  default: "h-9 gap-2 rounded-md px-3 text-sm",
  chip: "h-6 gap-1.5 rounded-full pr-2.5 pl-1.5 text-xs"
}

/** For links that look like buttons. */
export const buttonClass = (variant: Variant = "secondary", size: Size = "default") =>
  `inline-flex shrink-0 items-center justify-center ${sizes[size]} font-medium whitespace-nowrap outline-none transition-colors select-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 ${variants[variant]}`

/**
 * A `Button` that's a link, for what opens in the center column (owner, 2026-11-05: it opens
 * in a new browser tab too): a plain click runs `onOpen`; a right-click shows its open menu
 * (LinkMenu.tsx).
 */
export function LinkButton({
  href,
  onOpen,
  hint,
  variant = "secondary",
  className = "",
  children,
  "aria-label": label
}: {
  href: string
  onOpen: () => void
  hint: ReactNode
  variant?: Variant
  className?: string
  children: ReactNode
  "aria-label"?: string
}) {
  const id = useId()
  return (
    <>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger
          render={
            <a
              href={href}
              aria-label={label}
              aria-describedby={id}
              className={`${buttonClass(variant)} ${className}`}
              onClick={openOnPlainClick(onOpen)}
              {...linkMenuProps}
            >
              {children}
            </a>
          }
        />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner
            data-layout-overlay="Tooltip floats above the page"
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className="pointer-events-none z-50"
          >
            <BaseTooltip.Popup className={tooltipPopupClass}>{hint}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
      <span id={id} hidden>
        {hint}
      </span>
    </>
  )
}

/** The tooltip popup's look, shared with `Tooltip`. */
export const tooltipPopupClass =
  "pointer-events-none max-w-[min(18rem,calc(100vw-1rem))] origin-[var(--transform-origin)] rounded-md bg-text px-2 py-1 text-xs text-canvas shadow-md transition-[scale,opacity] duration-100 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"

/**
 * `pending` disables the button and shows a spinner while its action runs. `hint` explains
 * what it does, beside it on hover and keyboard focus and to screen readers as its description,
 * so its label can stay short.
 */
export function Button({
  variant = "secondary",
  size = "default",
  pending = false,
  className = "",
  children,
  disabled,
  hint,
  ...props
}: ComponentProps<typeof BaseButton> & {
  variant?: Variant | undefined
  size?: Size | undefined
  pending?: boolean | undefined
  hint?: ReactNode
}) {
  const id = useId()
  const button = (
    <BaseButton
      className={`${buttonClass(variant, size)} ${pending || props.focusableWhenDisabled ? "data-disabled:pointer-events-auto!" : ""} ${className}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      focusableWhenDisabled={pending}
      {...(hint === undefined || hint === null ? {} : { "aria-describedby": id })}
      {...props}
    >
      {pending && <Spinner />}
      {children}
    </BaseButton>
  )
  if (hint === undefined || hint === null) return button
  return (
    <>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={button} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner
            data-layout-overlay="Tooltip floats above the page"
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className="pointer-events-none z-50"
          >
            <BaseTooltip.Popup className={tooltipPopupClass}>{hint}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
      <span id={id} hidden>
        {hint}
      </span>
    </>
  )
}
