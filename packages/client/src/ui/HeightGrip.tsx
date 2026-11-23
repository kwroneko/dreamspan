// The corner grip of a text box that isn't a native textarea (the code editor): drag it to set
// the box's height, as a textarea's own resize corner does; a double-click returns the box to
// fitting its text. A height chosen lasts as long as the box is open in this page: it's never
// saved or restored (layouts come from the URL only).
import { type MouseEvent, type PointerEvent, useRef } from "react"
import { Tooltip } from "./Tooltip.tsx"

const HINT = "Drag to change the box's height. Double-click to let it fit its text again."

/** The shortest a dragged box gets: about two lines. */
const MIN_DRAGGED_HEIGHT = 64

export function HeightGrip({
  label,
  height,
  onHeight,
  onReset
}: {
  /** The box's name, for the grip's accessible name. */
  label: string
  /** The box's height now, in pixels, where a drag starts from. */
  height: () => number
  /** A height chosen by the drag, at least `MIN_DRAGGED_HEIGHT`. */
  onHeight: (height: number) => void
  onReset: () => void
}) {
  const drag = useRef<{ y: number; height: number } | null>(null)
  return (
    <Tooltip label={HINT} side="bottom">
      <span
        aria-label={`Resize ${label}`}
        data-height-grip
        // Pointer only, as a textarea's corner is: a tab stop on every text box would be in the way.
        className="-mr-1.5 flex size-4 shrink-0 cursor-ns-resize touch-none items-end justify-end self-end pb-0.5 text-muted select-none hover:text-text max-sm:size-8"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          // Keeps the editor's focus and selection, and stops a text selection starting.
          event.preventDefault()
          drag.current = { y: event.clientY, height: height() }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (start) onHeight(Math.max(MIN_DRAGGED_HEIGHT, Math.round(start.height + event.clientY - start.y)))
        }}
        onPointerUp={(event) => {
          drag.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => (drag.current = null)}
        onLostPointerCapture={() => (drag.current = null)}
        onDoubleClick={onReset}
      >
        <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor">
          <path d="M9 1 1 9M9 5 5 9" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
    </Tooltip>
  )
}

/**
 * A native textarea's resize corner, as the code editor's grip behaves: the drag that starts
 * there lifts the box's max-height (from the moment it starts, at the height it has, so nothing
 * jumps), and a double-click there returns the box to its own sizing. Spread on the textarea.
 */
export const textareaResize = {
  onPointerDown: (event: PointerEvent<HTMLTextAreaElement>) => {
    const box = event.currentTarget
    if (event.button !== 0 || !inResizeCorner(box, event)) return
    const before = { height: box.style.height, maxHeight: box.style.maxHeight, at: box.offsetHeight }
    box.style.height = `${before.at}px`
    box.style.maxHeight = "none"
    // A press there that didn't resize (a click placing the caret) leaves the box as it was.
    addEventListener(
      "pointerup",
      () => {
        if (box.offsetHeight !== before.at) return
        box.style.height = before.height
        box.style.maxHeight = before.maxHeight
      },
      { once: true, capture: true }
    )
  },
  onDoubleClick: (event: MouseEvent<HTMLTextAreaElement>) => {
    const box = event.currentTarget
    if (!inResizeCorner(box, event)) return
    box.style.removeProperty("height")
    box.style.removeProperty("max-height")
  }
}

/** The corner a textarea's resizer takes (Chromium and Firefox draw it about 12-16px square). */
const inResizeCorner = (box: HTMLTextAreaElement, event: { clientX: number; clientY: number }) => {
  if (getComputedStyle(box).resize === "none") return false
  const rect = box.getBoundingClientRect()
  return event.clientX >= rect.right - 18 && event.clientY >= rect.bottom - 18
}
