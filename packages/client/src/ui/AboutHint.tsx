// A quiet "?" beside a heading, for the few headings the user needs explained to choose
// correctly (DESIGN §10.1): its explanation shows in the tooltip-styled popup on hover, focus
// or tap, and is the button's description for screen readers. Headings that say it all get none.
import { Button as BaseButton } from "@base-ui/react/button"
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode
} from "react"
import { tooltipPopupClass } from "./Button.tsx"
import { Icon } from "./Icon.tsx"

/** Shared geometry for tooltip and popover help triggers. */
export const aboutHintClass =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-full align-[-2px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"

/** Inline text flow keeps help beside the final word, including when a label wraps. */
export function LabelWithHelp({ children, help }: { children: ReactNode; help: ReactNode }) {
  const trail = useLabelTrail()
  return (
    <span className="text-sm leading-5">
      {children}
      {help && (
        <>
          {"\u00a0"}
          {help}
        </>
      )}
      {trail && <> {trail}</>}
    </span>
  )
}

interface Trail {
  readonly node: ReactNode
  readonly owner: string | null
  readonly claim: (id: string, claimed: boolean) => void
}
const TrailContext = createContext<Trail | null>(null)

/**
 * Something shown after the first label inside (and its "?"), in the label's own line: a mass
 * edit's mark that the selected items differ. Without a label to take it, it shows after
 * `children`.
 */
export function LabelTrail({ node, children }: { node: ReactNode; children: ReactNode }) {
  const [owner, setOwner] = useState<string | null>(null)
  const claim = useCallback(
    (id: string, claimed: boolean) =>
      setOwner((current) => (claimed ? (current ?? id) : current === id ? null : current)),
    []
  )
  const value = useMemo(() => ({ node, owner, claim }), [node, owner, claim])
  return (
    <TrailContext.Provider value={value}>
      {children}
      {owner === null && node}
    </TrailContext.Provider>
  )
}

/** The trail this label shows: the one of the nearest `LabelTrail`, when this is its first label. */
export function useLabelTrail(shown = true): ReactNode {
  const trail = useContext(TrailContext)
  const id = useId()
  const claim = shown ? trail?.claim : undefined
  useLayoutEffect(() => {
    if (!claim) return
    claim(id, true)
    return () => claim(id, false)
  }, [claim, id])
  return trail?.owner === id ? trail.node : null
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
