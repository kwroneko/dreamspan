import { type ComponentProps, useCallback, useEffect, useLayoutEffect, useRef } from "react"

/**
 * The composer's box: one line when empty, growing with its text up to a third of the screen.
 *
 * Its height is measured on a hidden twin, never by setting the box itself to `auto`: that
 * shrank the box to one line for the measurement, the message list above grew into the space,
 * the browser clamped the list's scroll position to the new end, and putting the height back
 * left the list short of its end. The space under the last message closed and reopened with
 * every character typed into text of several lines (owner, 2026-11-23).
 */
export function AutoGrowTextarea(props: ComponentProps<"textarea"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const twin = useRef<HTMLTextAreaElement | null>(null)
  const fit = useCallback(() => {
    const box = ref.current
    if (box === null) return
    let measure = twin.current
    if (measure === null || measure.parentElement !== box.parentElement) {
      measure?.remove()
      measure = document.createElement("textarea")
      measure.setAttribute("aria-hidden", "true")
      measure.tabIndex = -1
      measure.rows = 1
      twin.current = measure
      box.parentElement?.append(measure)
    }
    // The same classes, so the same font, padding and line height; out of the layout and unseen.
    measure.className = box.className
    Object.assign(measure.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      top: "0",
      left: "0",
      height: "auto",
      minHeight: "0",
      maxHeight: "none",
      overflow: "hidden",
      width: `${box.offsetWidth}px`,
      display: "block"
    })
    measure.value = box.value || box.placeholder
    const fitted = `${Math.min(measure.scrollHeight, Math.max(160, innerHeight / 3))}px`
    // Out of every layout between measurements, so it never adds to anything's scroll size.
    measure.style.display = "none"
    if (box.style.height !== fitted) box.style.height = fitted
  }, [])
  useLayoutEffect(fit, [fit, props.value, props.placeholder])
  useEffect(
    () => () => {
      twin.current?.remove()
      twin.current = null
    },
    []
  )
  // The same text takes more lines in a narrower box: a phone turned, a panel opened.
  useEffect(() => {
    const box = ref.current
    if (box === null || typeof ResizeObserver === "undefined") return
    let width = box.clientWidth
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return
      width = box.clientWidth
      fit()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [fit])
  return (
    <textarea
      ref={ref}
      rows={1}
      {...props}
      className="max-h-[33vh] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-base text-text outline-none placeholder:text-muted sm:text-sm"
    />
  )
}
