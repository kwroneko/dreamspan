// A text box's own controls inside its border (owner, 2026-11-02; DESIGN §10.1): the text actions,
// its edit history, Open large, its token count, the "edited" marker. They sit in a strip along
// one of the box's borders, inside it: under a multi-line box's text, at a one-line box's end.
// The strip always takes its room, shown or not and full or empty, so focusing, typing, a change
// or leaving the box never moves anything around the box, and the text never runs under a
// control. It shows only while the pointer is over the box or focus is in it (styles.css), and
// comes after the box in the focus order.
import type { ReactNode } from "react"

/** The box's border and focus ring, which the frame takes over from the control inside it. */
const frame =
  "relative flex min-w-0 rounded-md border border-border bg-surface shadow-xs transition-shadow focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/40 has-[[data-invalid]]:border-danger"

/** A control inside a frame: no border or ring of its own, the frame's background. */
export const framedControl =
  "w-full min-w-0 border-0 bg-transparent px-3 text-base text-text outline-none placeholder:text-muted disabled:opacity-50 sm:text-sm"

/** A button in the strip: small, and a touch target on a phone. */
export const chromeButton = "size-6! max-sm:size-8!"

export function FieldFrame({
  side,
  strip = true,
  status,
  tools,
  children,
  className = ""
}: {
  /** "bottom" under a multi-line box's text; "end" at a one-line box's end. */
  side: "bottom" | "end"
  /** False: only the border, for a box that never has controls (a pattern, a template). */
  strip?: boolean
  /** What the box's text is now, at the strip's start: "edited", its token count. */
  status?: ReactNode
  /** The controls, at the strip's end; the strip takes its room even when there are none now. */
  tools: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-field-frame
      className={`${frame} ${side === "bottom" ? "flex-col" : "flex-row items-center"} ${className}`}
    >
      {children}
      {strip && (
        <div
          data-field-chrome
          // Its controls are compact by design, along the box's own border (DESIGN §10.1): the box's
          // edge isn't a container edge they need clearance from. Left and right still have px-2.
          data-layout-audit-ignore="inset: The box's own controls sit in a slim strip along its border"
          className={
            side === "bottom"
              ? "flex h-7 shrink-0 items-center justify-end gap-0.5 overflow-hidden px-2 max-sm:h-9"
              : "flex h-full w-[5.5rem] shrink-0 items-center justify-end gap-0.5 overflow-hidden pr-1"
          }
        >
          {status && <span className="mr-auto flex min-w-0 items-center gap-2 pl-1 text-xs text-muted">{status}</span>}
          {tools}
        </div>
      )}
    </div>
  )
}
