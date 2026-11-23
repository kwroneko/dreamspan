// A quiet "?" beside a heading, for the few headings the user needs explained to choose
// correctly (DESIGN §10.1): its explanation shows in the tooltip-styled popup on hover, focus
// or tap, and is the button's description for screen readers. Headings that say it all get none.
import { Button as BaseButton } from "@base-ui/react/button"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import { useId, useState, type ReactNode } from "react"
import { tooltipPopupClass } from "./Button.tsx"
import { Icon } from "./Icon.tsx"

/** Shared geometry for tooltip and popover help triggers. */
export const aboutHintClass =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-full align-[-2px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"

/** Inline text flow keeps help beside the final word, including when a label wraps. */
export function LabelWithHelp({ children, help }: { children: ReactNode; help: ReactNode }) {
  return (
    <span className="text-sm leading-5">
      {children}
      {help && (
        <>
          {"\u00a0"}
          {help}
        </>
      )}
    </span>
  )
}

/** The info variant: a circled (i) at icon size beside a control, for bars of controls rather than headings. */
const infoHintClass =
  "-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md align-middle text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"

export function AboutHint({
  heading,
  children,
  info = false
}: {
  heading: string
  children: ReactNode
  /** A circled (i) at icon size instead of the small "?". */
  info?: boolean
}) {
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
            className={info ? infoHintClass : aboutHintClass}
          >
            {info ? <Icon name="info" /> : <Icon name="help" size={14} />}
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
