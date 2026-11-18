// The desktop's resizable columns: a width chosen in this browser tab, with a minimum and no
// maximum but the room the other columns and the middle leave (columnLayout.ts). The choice is
// a layout param in the tab's URL (`tabLayoutParams.ts`), whole pixels, absent at the default,
// written once when a drag ends. A window too narrow for it shows less, never rewriting it.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { holdLayoutWrites, useLayoutNumber, writeLayoutParam } from "../tabLayoutParams.ts"
import { removeColumn, setColumn, useColumnWidth } from "./columnLayout.ts"
import { Tooltip } from "./Tooltip.tsx"

/** Each column's param (registered as layout params by the shell). */
export const WIDTH_PARAMS = { sidebar: "sbw", chat: "cpw", portrait: "ptw", presetOutline: "pow" } as const

const write = (key: string, value: number | null, initial: number) =>
  writeLayoutParam(key, value === null || value === initial ? null : String(value))

/**
 * A column's width: the choice in this tab's URL (`WIDTH_PARAMS`) or `initial`, at
 * least `min`, shown as the room allows. `active` false (a phone's sheet) leaves the layout.
 * `initial` may change (the portrait column's follows its image) while no choice is stored.
 * `yields`: which give way first in a short window (columnLayout.ts).
 */
export function usePanelWidth(
  panel: "sidebar" | "chat" | "portrait",
  initial: number,
  min: number,
  active = true,
  yields = 0
) {
  const key = WIDTH_PARAMS[panel]
  const saved = useLayoutNumber(key, min)
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
  // The portrait column's default follows its image: a width chosen stays, even one equal to it.
  const omitAt = panel === "portrait" ? Number.NaN : initial
  const change = (next: number) => write(key, Math.round(Math.max(min, Math.min(max, next))), omitAt)
  const reset = () => write(key, null, omitAt)
  return { width, min, max, change, reset }
}

/**
 * A column inside a page rather than beside the chat (the preset editor's outline): the
 * choice in this tab's URL (`WIDTH_PARAMS`) or `initial`, between `min` and `limit`,
 * and never so wide that its parent keeps less than `reserve` for the rest. It isn't one of
 * the window's columns (columnLayout.ts), so it measures its parent instead.
 */
export function useInnerPanelWidth(
  panel: "presetOutline",
  initial: number,
  min: number,
  limit: number,
  reserve: number
) {
  const key = WIDTH_PARAMS[panel]
  const saved = useLayoutNumber(key, min)
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
  const change = (next: number) => write(key, Math.round(Math.max(min, Math.min(max, next))), initial)
  const reset = () => write(key, null, initial)
  return { ref, width, min, max, change, reset }
}

/** A keyboard resize writes the URL this long after the last key, if no key is let go first. */
const KEY_IDLE_MS = 400

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
  const drag = useRef<{ at: number; width: number; release: () => void } | null>(null)
  // A drag's widths show at once and reach the URL once, when it ends.
  const end = () => {
    drag.current?.release()
    drag.current = null
  }
  // Arrow keys (held down, they repeat) show each step at once and write the URL once the keys
  // are let go, or after a short pause: never a URL write per repeat.
  const keys = useRef<{ release: () => void; timer: ReturnType<typeof setTimeout> } | null>(null)
  const endKeys = () => {
    if (!keys.current) return
    clearTimeout(keys.current.timer)
    keys.current.release()
    keys.current = null
  }
  const holdKeys = () => {
    if (keys.current) clearTimeout(keys.current.timer)
    keys.current = { release: keys.current?.release ?? holdLayoutWrites(), timer: setTimeout(endKeys, KEY_IDLE_MS) }
  }
  useEffect(
    () => () => {
      drag.current?.release()
      endKeys()
    },
    []
  )
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
          drag.current?.release()
          drag.current = { at: at(event), width, release: holdLayoutWrites() }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (drag.current) onChange(drag.current.width + (at(event) - drag.current.at) * direction)
        }}
        onPointerUp={(event) => {
          end()
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={onReset}
        onKeyUp={endKeys}
        onBlur={endKeys}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) holdKeys()
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
