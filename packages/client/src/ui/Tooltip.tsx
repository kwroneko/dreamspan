// A hint shown on hover or keyboard focus, for sighted users: what an icon or a terse button
// does. It never carries the only label: the trigger keeps its own accessible name.
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import type { ComponentProps, ReactElement, ReactNode } from "react"
import { Button } from "./Button.tsx"

export function Tooltip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={400} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} className="z-50">
          <BaseTooltip.Popup className="max-w-72 origin-[var(--transform-origin)] rounded-md border border-border bg-surface-raised px-2 py-1 text-xs text-text shadow-md transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

/** A square button showing only an icon: `label` is its accessible name, and its tooltip unless `hint` is given. */
export function IconButton({
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
