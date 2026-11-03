// The desktop's resizable columns: a width each user chooses in this browser, with a minimum
// and no maximum but the room the other columns and the middle leave (columnLayout.ts). What
// is stored is the choice; a window too narrow for it shows less, never rewriting it.
import { useLayoutEffect, useRef, useState } from "react"
import { removeColumn, setColumn, useColumnWidth } from "./columnLayout.ts"
import { Tooltip } from "./Tooltip.tsx"

const read = (key: string, min: number) => {
  try {
    const stored = localStorage.getItem(key)
    const value = Number(stored)
    return stored !== null && Number.isFinite(value) && value >= min ? value : null
  } catch {
    return null
  }
}
const write = (key: string, value: number | null) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(value))
  } catch {
    /* In memory when storage is off. */
  }
}

/**
 * A column's width: the user's choice (`rp.panelWidth.<user id>.<panel>`) or `initial`, at
 * least `min`, shown as the room allows. `active` false (a phone's sheet) leaves the layout.
 * `initial` may change (the portrait column's follows its image) while no choice is stored.
 * `yields`: which give way first in a short window (columnLayout.ts).
 */
export function usePanelWidth(
  userId: string,
  panel: "sidebar" | "chat" | "portrait",
  initial: number,
  min: number,
  active = true,
  yields = 0
) {
  const key = `rp.panelWidth.${userId}.${panel}`
  const [saved, setSaved] = useState(() => read(key, min))
  const entry = active ? { preferred: saved ?? initial, min, yields } : null
  const preferred = entry?.preferred
  useLayoutEffect(() => {
    if (preferred === undefined) return
    setColumn(panel, { preferred, min, yields })
  }, [panel, preferred, min, yields])
  useLayoutEffect(() => () => removeColumn(panel), [panel])
  useLayoutEffect(() => {
    if (!active) removeColumn(panel)
  }, [active, panel])
  const { width, max } = useColumnWidth(panel, entry)
  const change = (next: number) => {
    const value = Math.round(Math.max(min, Math.min(max, next)))
    setSaved(value)
    write(key, value)
  }
  const reset = () => {
    setSaved(null)
    write(key, null)
  }
  return { width, min, max, change, reset }
}

/**
 * A column inside a page rather than beside the chat (the preset editor's outline): the
 * user's choice (`rp.panelWidth.<user id>.<panel>`) or `initial`, between `min` and `limit`,
 * and never so wide that its parent keeps less than `reserve` for the rest. It isn't one of
 * the window's columns (columnLayout.ts), so it measures its parent instead.
 */
export function useInnerPanelWidth(
  userId: string,
  panel: "presetOutline",
  initial: number,
  min: number,
  limit: number,
  reserve: number
) {
  const key = `rp.panelWidth.${userId}.${panel}`
  const [saved, setSaved] = useState(() => read(key, min))
  const ref = useRef<HTMLElement>(null)
  const [available, setAvailable] = useState(window.innerWidth)
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width)
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])
  const max = Math.max(min, Math.min(limit, available - reserve))
  const width = Math.max(min, Math.min(max, saved ?? initial))
  const change = (next: number) => {
    const value = Math.round(Math.max(min, Math.min(max, next)))
    setSaved(value)
    write(key, value)
  }
  const reset = () => {
    setSaved(null)
    write(key, null)
  }
  return { ref, width, min, max, change, reset }
}

const HINT = "Drag to resize, or use the arrow keys (Shift for bigger steps), Home and End. Double-click resets."
const SPLIT_HINT =
  "Drag to share the height between these two images, or use the up and down arrow keys (Shift for bigger steps), Home and End. Double-click makes them equal."

/**
 * The grip on a column's edge: drag it, or focus it and use the arrow keys (10 px, Shift
 * 40 px), Home (the minimum) and End (as wide as the room allows); a double-click returns to
 * the default. `axis` "y" is a boundary between two stacked boxes (the portrait column's
 * viewers): the grip lies along the bottom of the one above, dragged up and down, its value
 * that one's height, with the up and down arrows.
 */
export function ResizeHandle({
  label,
  width,
  min,
  max,
  direction,
  axis = "x",
  hint: customHint,
  onChange,
  onReset
}: {
  label: string
  width: number
  min: number
  max: number
  direction: 1 | -1
  axis?: "x" | "y"
  hint?: string
  onChange: (width: number) => void
  onReset: () => void
}) {
  const drag = useRef<{ at: number; width: number } | null>(null)
  const vertical = axis === "y"
  const at = (event: { clientX: number; clientY: number }) => (vertical ? event.clientY : event.clientX)
  const [less, more] = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"]
  const hint = customHint ?? (vertical ? SPLIT_HINT : HINT)
  return (
    <Tooltip label={hint} side={vertical ? "bottom" : direction === 1 ? "right" : "left"}>
      <div
        role="separator"
        data-layout-overlay="Resize hit target straddles the column boundary"
        aria-label={label}
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`${Math.round(width)} pixels`}
        aria-description={hint}
        tabIndex={0}
        data-resize-handle
        className={`absolute z-10 touch-none outline-none hover:bg-accent/20 focus-visible:bg-accent/20 focus-visible:ring-2 focus-visible:ring-focus ${
          vertical ? "inset-x-0 h-2 cursor-row-resize" : "inset-y-0 w-2 cursor-col-resize"
        }`}
        style={vertical ? { bottom: -4 } : direction === 1 ? { right: -4 } : { left: -4 }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          drag.current = { at: at(event), width }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (drag.current) onChange(drag.current.width + (at(event) - drag.current.at) * direction)
        }}
        onPointerUp={(event) => {
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onLostPointerCapture={() => {
          drag.current = null
        }}
        onDoubleClick={onReset}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 10
          if (event.key === less || event.key === more) {
            event.preventDefault()
            onChange(width + (event.key === more ? step : -step) * direction)
          } else if (event.key === "Home") {
            event.preventDefault()
            onChange(min)
          } else if (event.key === "End") {
            event.preventDefault()
            onChange(max)
          }
        }}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-full bg-border ${
            vertical ? "top-0.5 left-1/2 h-1 w-10 -translate-x-1/2" : "top-1/2 left-0.5 h-10 w-1 -translate-y-1/2"
          }`}
        />
      </div>
    </Tooltip>
  )
}
