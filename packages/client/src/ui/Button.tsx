// Feature code imports UI from here, never from Base UI directly (CLIENT-FRAMEWORK.md §8):
// Base UI carries behavior and accessibility, this layer carries the look.
import { Button as BaseButton } from "@base-ui/react/button"
import type { ComponentProps } from "react"
import { Spinner } from "./Spinner.tsx"

type Variant = "primary" | "secondary" | "ghost" | "danger"

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:opacity-90",
  secondary: "bg-surface-raised text-text border border-border hover:bg-surface",
  ghost: "text-muted hover:text-text hover:bg-surface-raised",
  danger: "bg-danger text-danger-contrast hover:opacity-90"
}

/** For links that look like buttons. */
export const buttonClass = (variant: Variant = "secondary") =>
  `inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors select-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 ${variants[variant]}`

/** `pending` disables the button and shows a spinner while its action runs. */
export function Button({
  variant = "secondary",
  pending = false,
  className = "",
  children,
  disabled,
  ...props
}: ComponentProps<typeof BaseButton> & { variant?: Variant | undefined; pending?: boolean | undefined }) {
  return (
    <BaseButton
      className={`${buttonClass(variant)} ${className}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      focusableWhenDisabled={pending}
      {...props}
    >
      {pending && <Spinner />}
      {children}
    </BaseButton>
  )
}
