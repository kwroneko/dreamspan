// Whether a single-line text box needs its full text on hover. CSS owns the ellipsis;
// measuring only decides whether its explanation needs to repeat the full text.
import { useEffect, useState } from "react"

export function useTruncated(text: string) {
  // The display node can be replaced by a rename field and mounted again afterwards.
  const [element, ref] = useState<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    if (!element) return
    let active = true
    const measure = () => {
      if (active) setTruncated(element.scrollWidth > element.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    void document.fonts.ready.then(measure)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [element, text])
  return { ref, truncated }
}
