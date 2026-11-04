// Measure the actual CSS box, including grid/collage cells and resizable panels. No
// initial guessed URL: the first request uses rendered width × the screen's density.
import { cropKey, type AvatarCrop, mediaWidth } from "@rp/shared/media.ts"
import { useCallback, useState } from "react"

export const mediaUrl = (id: string, width?: number) =>
  `/library/media?id=${encodeURIComponent(id)}${width === undefined ? "" : `&w=${mediaWidth(width)}`}`

export function useMediaWidth() {
  const [width, setWidth] = useState<number>()
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const measure = () => {
      const pixels = node.getBoundingClientRect().width
      if (pixels > 0) setWidth(mediaWidth(pixels * window.devicePixelRatio))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    // Moving a window to another display can change density without changing CSS width.
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])
  return { ref, width }
}

export const pictureUrl = (id: string, picture?: AvatarCrop | undefined) =>
  `${mediaUrl(id)}${picture ? `&picture=${cropKey(picture)}` : ""}`
