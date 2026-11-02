// A quiet "?" beside a heading, for the few headings the user needs explained to choose
// correctly (DESIGN §10.1): its explanation shows in the tooltip-styled popup on hover, focus
// or tap, and is the button's description for screen readers. Headings that say it all get none.
import { Button as BaseButton } from "@base-ui/react/button"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import { useId, useState, type ReactNode } from "react"
import { tooltipPopupClass } from "./Button.tsx"
import { Icon } from "./Icon.tsx"

export function AboutHint({ heading, children }: { heading: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <BaseTooltip.Root open={open} onOpenChange={setOpen}>
      <BaseTooltip.Trigger
        render={
          <BaseButton
            data-about-hint=""
            aria-label={`About ${heading}`}
            aria-describedby={id}
            // A tap opens it too, where nothing hovers; a tap elsewhere closes it.
            onClick={() => setOpen(true)}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="help" size={14} />
          </BaseButton>
        }
      />
      <span id={id} hidden>
        {children}
      </span>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="top" sideOffset={6} className="pointer-events-none z-50">
          <BaseTooltip.Popup className={tooltipPopupClass}>{children}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
