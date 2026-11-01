// Explanations for the items of a menu or a select: a short sentence saying what an item does,
// so its label can stay short. With a mouse it shows beside the highlighted item (hovered, or
// reached with the arrow keys), outside the list, so it never covers the rows below; on a touch
// screen or a narrow window there's no hover and no room beside, so it shows under the label in
// muted text. A screen reader reads it as the item's description either way.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

/** The window widths and pointers that show explanations inline: phones and touch screens. */
export const inlineExplanationClass = "max-sm:block pointer-coarse:block"

/**
 * An item's explanation: `parts`, its copy under the label, shown on touch screens and narrow
 * windows and kept out of its name, which is its description for screen readers everywhere;
 * and `describedBy`, to spread on the item, which also hands the text to `HighlightExplanation`.
 */
export function useItemExplanation(description: string | undefined) {
  const id = useId()
  if (!description) return { describedBy: {}, parts: null }
  return {
    describedBy: { "aria-describedby": id, "data-explain": description },
    // Hidden from the name, and still the description: a reference reads hidden text.
    parts: (
      <span
        id={id}
        aria-hidden="true"
        className={`hidden pt-0.5 text-xs font-normal text-muted ${inlineExplanationClass}`}
      >
        {description}
      </span>
    )
  }
}

// Shown after a pause on the first item, then at once on every other while the list is open,
// as moving along a toolbar's tooltips does.
const FIRST_DELAY = 350
const GAP = 8
const WIDTH = 288
const MARGIN = 8

interface Shown {
  readonly text: string
  readonly top: number
  readonly side: "right" | "left"
  readonly maxWidth: number
}

/**
 * The box beside the highlighted item of `popup`, rendered inside its positioner (so the list's
 * own scrolling never clips it). It follows `data-highlighted` on the items that carry
 * `data-explain`, whichever way they were highlighted.
 */
export function HighlightExplanation({ popup }: { popup: HTMLElement | null }) {
  const [shown, setShown] = useState<Shown | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!popup) return
    const positioner = popup.parentElement
    if (!positioner) return
    let warm = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const place = (item: HTMLElement, text: string): Shown => {
      const frame = positioner.getBoundingClientRect()
      const row = item.getBoundingClientRect()
      const right = window.innerWidth - frame.right - GAP - MARGIN
      const left = frame.left - GAP - MARGIN
      const side = right >= WIDTH || right >= left ? "right" : "left"
      return {
        text,
        top: row.top - frame.top,
        side,
        maxWidth: Math.min(WIDTH, Math.max(side === "right" ? right : left, 120))
      }
    }
    const update = () => {
      clearTimeout(timer)
      const item = popup.querySelector<HTMLElement>("[data-highlighted][data-explain]")
      const text = item?.dataset["explain"]
      if (!item || !text) {
        setShown(null)
        return
      }
      if (warm) {
        setShown(place(item, text))
        return
      }
      timer = setTimeout(() => {
        warm = true
        if (item.isConnected && item.hasAttribute("data-highlighted")) setShown(place(item, text))
      }, FIRST_DELAY)
    }
    const observer = new MutationObserver(update)
    observer.observe(popup, { subtree: true, attributes: true, attributeFilter: ["data-highlighted", "data-explain"] })
    popup.addEventListener("scroll", update, { passive: true })
    update()
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      popup.removeEventListener("scroll", update)
    }
  }, [popup])
  // Kept inside the window: one near the bottom moves up as far as it needs.
  useLayoutEffect(() => {
    const element = box.current
    if (!element || !shown) return
    element.style.translate = ""
    const rect = element.getBoundingClientRect()
    const over = rect.bottom - (window.innerHeight - MARGIN)
    const under = MARGIN - rect.top
    if (over > 0) element.style.translate = `0 ${-Math.min(over, rect.top - MARGIN)}px`
    else if (under > 0) element.style.translate = `0 ${under}px`
  }, [shown])
  if (!shown) return null
  return (
    <div
      ref={box}
      role="presentation"
      aria-hidden="true"
      data-explanation=""
      style={{
        top: shown.top,
        maxWidth: shown.maxWidth,
        ...(shown.side === "right" ? { left: `calc(100% + ${GAP}px)` } : { right: `calc(100% + ${GAP}px)` })
      }}
      className="pointer-events-none absolute z-10 w-max rounded-md bg-text px-2 py-1 text-xs text-canvas shadow-md max-sm:hidden pointer-coarse:hidden"
    >
      {shown.text}
    </div>
  )
}
