// Shared desktop sidebar sizing. Widths belong to the signed-in user in this browser;
// their displayed bounds follow the available space, without overwriting a wider choice.
import { useEffect, useRef, useState } from "react"

export function usePanelWidth(
  userId: string,
  panel: "sidebar" | "chat" | "presetOutline",
  initial: number,
  min: number,
  limit: number,
  reserve: number,
  active = true
) {
  const key = `rp.panelWidth.${userId}.${panel}`
  const [saved, setSaved] = useState(() => {
    try {
      const value = Number(localStorage.getItem(key))
      return Number.isFinite(value) && value >= min ? value : initial
    } catch {
      return initial
    }
  })
  const ref = useRef<HTMLElement>(null)
  const [available, setAvailable] = useState(window.innerWidth)
  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width)
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [active])
  const max = Math.max(min, Math.min(limit, available - reserve))
  const width = Math.max(min, Math.min(max, saved))
  const change = (next: number) => {
    const value = Math.max(min, Math.min(max, next))
    setSaved(value)
    try {
      localStorage.setItem(key, String(value))
    } catch {
      /* In memory when storage is off. */
    }
  }
  return { ref, width, min, max, change, reset: () => change(initial) }
}

export function ResizeHandle({
  label,
  width,
  min,
  max,
  direction,
  onChange,
  onReset
}: {
  label: string
  width: number
  min: number
  max: number
  direction: 1 | -1
  onChange: (width: number) => void
  onReset: () => void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)} pixels`}
      tabIndex={0}
      title="Drag or use arrow keys to resize. Double-click to reset."
      className="absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none hover:bg-accent/20 focus-visible:bg-accent/20 focus-visible:ring-2 focus-visible:ring-focus"
      style={direction === 1 ? { right: -4 } : { left: -4 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        drag.current = { x: event.clientX, width }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (drag.current) onChange(drag.current.width + (event.clientX - drag.current.x) * direction)
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
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault()
          onChange(width + (event.key === "ArrowRight" ? step : -step) * direction)
        } else if (event.key === "Home") {
          event.preventDefault()
          onReset()
        }
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-0.5 h-10 w-1 rounded-full bg-border"
      />
    </div>
  )
}
