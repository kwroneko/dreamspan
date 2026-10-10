// Feature code imports UI from here, never from Base UI directly (CLIENT-FRAMEWORK.md §8):
// Base UI carries behavior and accessibility, this layer carries the look.
import { Button as BaseButton } from "@base-ui/react/button"
import type { ComponentProps } from "react"

type Variant = "primary" | "secondary" | "ghost"

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:opacity-90",
  secondary: "bg-surface-raised text-text border border-border hover:bg-surface",
  ghost: "text-muted hover:text-text hover:bg-surface-raised"
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<typeof BaseButton> & { variant?: Variant }) {
  return (
    <BaseButton
      className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  )
}
