import { type ReactNode, useLayoutEffect, useRef } from "react"

export interface HighlightRange {
  readonly at: number
  readonly length: number
}

/** A non-interactive mirror preserves native text selection and the browser context menu. */
export function SearchHighlights({
  value,
  ranges,
  children,
  className = ""
}: {
  value: string
  ranges: ReadonlyArray<HighlightRange>
  className?: string
  children: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const clip = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = host.current?.querySelector("input, textarea")
    const text = mirror.current
    const viewport = clip.current
    if (!(box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) || !text || !viewport) return
    const sync = () => {
      const style = getComputedStyle(box)
      const bounds = box.getBoundingClientRect()
      const parent = host.current!.getBoundingClientRect()
      Object.assign(viewport.style, {
        left: `${bounds.left - parent.left + box.clientLeft}px`,
        top: `${bounds.top - parent.top + box.clientTop}px`,
        width: `${box.clientWidth}px`,
        height: `${box.clientHeight}px`
      })
      Object.assign(text.style, {
        font: style.font,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight,
        padding: style.padding,
        boxSizing: "border-box",
        width: `${box.clientWidth}px`,
        whiteSpace: box instanceof HTMLInputElement ? "pre" : "pre-wrap",
        overflowWrap: "break-word",
        transform: `translate(${-box.scrollLeft}px, ${-box.scrollTop}px)`
      })
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(box)
    box.addEventListener("scroll", sync)
    return () => {
      observer.disconnect()
      box.removeEventListener("scroll", sync)
    }
  }, [value, ranges])
  let cursor = 0
  const marked: ReactNode[] = []
  for (const [index, range] of ranges.entries()) {
    if (range.length <= 0) continue
    marked.push(value.slice(cursor, range.at))
    marked.push(
      <mark key={index} className="bg-warning/30 text-transparent">
        {value.slice(range.at, range.at + range.length)}
      </mark>
    )
    cursor = range.at + range.length
  }
  marked.push(value.slice(cursor), "\n")
  return (
    <div ref={host} className={`relative min-w-0 ${className}`}>
      {children}
      <div
        ref={clip}
        data-layout-overlay="Non-interactive search marks overlay the native text box"
        aria-hidden="true"
        className={`pointer-events-none absolute overflow-hidden ${ranges.length ? "" : "hidden"}`}
      >
        <div ref={mirror} className="text-transparent">
          {marked}
        </div>
      </div>
    </div>
  )
}
