// A whole image in a fixed box (owner, 2026-11-02: proper image-viewer controls): fitted to it
// (enlarged up to MAX_UPSCALE, never more), or at a scale of its own. The wheel zooms about the
// cursor, a drag pans, two fingers pinch about their centre and pan, and a double click or
// double tap switches between the fit and 100%. There are no scrollbars: the image moves
// inside the box, and panning stops before it would leave the box. Shared by the chat's
// portrait column and the full-screen viewer.
import { useEffect, useLayoutEffect, useRef, useState } from "react"

/** How far fitting enlarges a small image: past this, it's blur rather than detail. */
export const MAX_UPSCALE = 2
export const MAX_ZOOM = 8

export type Zoom = "fit" | number

export interface NaturalSize {
  readonly width: number
  readonly height: number
}

/** The scale that shows all of an image in a box. */
const fitScale = (natural: NaturalSize, box: NaturalSize) =>
  Math.min(box.width / natural.width, box.height / natural.height, MAX_UPSCALE)

/** The least a scale goes: the fit, or 100% for an image the fit enlarges. */
const minZoom = (fit: number) => Math.min(fit, 1)

/** A wheel's turn to a zoom factor: one notch (about 100 px) is about 15%. */
const wheelFactor = (event: WheelEvent) => {
  const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1)
  return Math.exp(-Math.max(-300, Math.min(300, pixels)) * 0.0014)
}

interface Point {
  readonly x: number
  readonly y: number
}
/** Where the image's top-left corner sits in the box, at a scale. */
interface Placed extends Point {
  readonly scale: number
}

/** Panned no further than keeps the image over the box's edges; an axis it doesn't fill is centred. */
const clampTo = (at: Point, shown: NaturalSize, box: NaturalSize): Point => ({
  x: shown.width <= box.width ? (box.width - shown.width) / 2 : Math.min(0, Math.max(box.width - shown.width, at.x)),
  y:
    shown.height <= box.height
      ? (box.height - shown.height) / 2
      : Math.min(0, Math.max(box.height - shown.height, at.y))
})

export function ImageViewer({
  src,
  placeholder,
  alt,
  zoom,
  onZoom,
  onScale,
  initials
}: {
  src: string
  /** A smaller copy shown (stretched) while the original loads; it gives the shape early. */
  placeholder?: string
  alt: string
  zoom: Zoom
  onZoom: (zoom: Zoom) => void
  /** The scale shown, and the least it goes, for the toolbar; the original's own size once it's loaded. */
  onScale?: (scale: number, natural: NaturalSize | null, min: number) => void
  /** Shown instead while images are hidden. */
  initials: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<NaturalSize | null>(null)
  const [natural, setNatural] = useState<NaturalSize | null>(null)
  // Only the placeholder's shape: the original's own pixels are unknown until it loads.
  const [shape, setShape] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const observer = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const known = natural ?? (shape !== null && size ? { width: size.height * shape * 4, height: size.height * 4 } : null)
  const fit = known && size && size.width > 0 && size.height > 0 ? fitScale(known, size) : null
  const scale = zoom === "fit" ? fit : zoom
  const shown = known && scale !== null ? { width: known.width * scale, height: known.height * scale } : null

  // Where the image sits: set by a drag, a wheel or a pinch at the scale it chose; a zoom from
  // the toolbar keeps the point at the box's centre where it was.
  const [placed, setPlaced] = useState<Placed | null>(null)
  const at = ((): Point | null => {
    if (!shown || !size || scale === null || !known) return null
    const before = placed
    if (zoom === "fit" || !before) return clampTo({ x: 0, y: 0 }, shown, size)
    if (before.scale === scale) return clampTo(before, shown, size)
    const cx = size.width / 2
    const cy = size.height / 2
    const fx = (cx - before.x) / (known.width * before.scale)
    const fy = (cy - before.y) / (known.height * before.scale)
    return clampTo({ x: cx - fx * shown.width, y: cy - fy * shown.height }, shown, size)
  })()
  // Kept as shown (React's "adjust state while rendering"), so the next toolbar zoom starts
  // from where the image is now, and a zoom from the fit starts from the fit.
  const want = zoom === "fit" || !at || scale === null ? null : { x: at.x, y: at.y, scale }
  if (
    want === null
      ? placed !== null
      : !placed || placed.x !== want.x || placed.y !== want.y || placed.scale !== want.scale
  )
    setPlaced(want)
  const pannable = shown !== null && size !== null && (shown.width > size.width + 1 || shown.height > size.height + 1)

  const lastScale = useRef<string>("")
  useLayoutEffect(() => {
    if (scale === null || fit === null) return
    const key = `${scale}:${fit}:${natural?.width}x${natural?.height}`
    if (key === lastScale.current) return
    lastScale.current = key
    onScale?.(scale, natural, minZoom(fit))
  })

  /** Zooms to `next`, keeping the image's point that was under `point` there (or `image`, as fractions). */
  const zoomAt = (next: number, point: Point, image?: Point) => {
    if (!known || !at || scale === null || fit === null) return
    const clamped = Math.min(MAX_ZOOM, Math.max(minZoom(fit), next))
    // Back to the fit when a zoom out reaches it, so Fit reads as chosen.
    if (Math.abs(clamped - fit) / fit < 0.01 && clamped <= fit) {
      setPlaced(null)
      onZoom("fit")
      return
    }
    const fx = image?.x ?? (point.x - at.x) / (known.width * scale)
    const fy = image?.y ?? (point.y - at.y) / (known.height * scale)
    setPlaced({
      scale: clamped,
      x: point.x - fx * known.width * clamped,
      y: point.y - fy * known.height * clamped
    })
    if (clamped !== scale) onZoom(clamped)
  }
  const toggle = (point: Point) => {
    if (!at || !known || scale === null) return
    if (zoom !== "fit") {
      setPlaced(null)
      onZoom("fit")
      return
    }
    zoomAt(1, point, {
      x: Math.min(1, Math.max(0, (point.x - at.x) / (known.width * scale))),
      y: Math.min(1, Math.max(0, (point.y - at.y) / (known.height * scale)))
    })
  }

  // The wheel's own listener (React's is passive, and can't keep the page from scrolling),
  // added again each render so it has the zoom as it is now.
  useEffect(() => {
    const node = box.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      // The page never scrolls under the image, even past the zoom's ends.
      event.preventDefault()
      if (scale === null || event.deltaY === 0) return
      const rect = node.getBoundingClientRect()
      zoomAt(scale * wheelFactor(event), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    node.addEventListener("wheel", onWheel, { passive: false })
    return () => node.removeEventListener("wheel", onWheel)
  })

  // Pointers down: one drags the image about, two pinch it about their centre.
  const pointers = useRef(new Map<number, Point>())
  const pinch = useRef<{ distance: number; scale: number; image: Point } | null>(null)
  const [dragging, setDragging] = useState(false)
  // A tap: where and when the last one ended, for a double tap; whether this one moved.
  const tap = useRef<{ x: number; y: number; time: number } | null>(null)
  const moved = useRef(false)
  const lastPointer = useRef<string>("mouse")
  const local = (event: { clientX: number; clientY: number }) => {
    const rect = box.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const spread = () => {
    const [a, b] = [...pointers.current.values()]
    return a && b
      ? { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      : null
  }
  const release = (id: number) => {
    pointers.current.delete(id)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) setDragging(false)
  }
  return (
    <div
      ref={box}
      data-image-viewer
      data-zoom={zoom === "fit" ? "fit" : "scaled"}
      className={`relative size-full touch-none overflow-hidden overscroll-contain select-none ${
        pannable ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
      }`}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return
        lastPointer.current = event.pointerType
        pointers.current.set(event.pointerId, local(event))
        if (pointers.current.size === 1) moved.current = false
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // A pointer the browser no longer has (lifted already): nothing to follow.
        }
        const two = spread()
        if (two && scale !== null && at && known)
          pinch.current = {
            distance: two.distance,
            scale,
            image: { x: (two.mid.x - at.x) / (known.width * scale), y: (two.mid.y - at.y) / (known.height * scale) }
          }
        else if (pannable) setDragging(true)
      }}
      onPointerMove={(event) => {
        const before = pointers.current.get(event.pointerId)
        if (!before) return
        const now = local(event)
        pointers.current.set(event.pointerId, now)
        if (Math.hypot(now.x - before.x, now.y - before.y) > 0) moved.current = true
        const two = spread()
        if (pinch.current && two && two.distance > 0) {
          zoomAt((pinch.current.scale * two.distance) / pinch.current.distance, two.mid, pinch.current.image)
        } else if (!pinch.current && at && scale !== null && zoom !== "fit") {
          setPlaced({ scale, x: at.x + now.x - before.x, y: at.y + now.y - before.y })
        }
      }}
      onPointerUp={(event) => {
        const point = local(event)
        const single = pointers.current.size === 1
        release(event.pointerId)
        if (event.pointerType !== "touch" || !single) return
        // A double tap: two taps that didn't move, close in time and place.
        const last = tap.current
        const now = event.timeStamp
        if (!moved.current && last && now - last.time < 350 && Math.hypot(point.x - last.x, point.y - last.y) < 30) {
          tap.current = null
          toggle(point)
        } else tap.current = moved.current ? null : { ...point, time: now }
      }}
      onPointerCancel={(event) => release(event.pointerId)}
      onLostPointerCapture={(event) => release(event.pointerId)}
      onDoubleClick={(event) => {
        // A touch's double tap is handled above, so a synthesised double click doesn't undo it.
        if (lastPointer.current === "touch") return
        toggle(local(event))
      }}
    >
      <span
        data-image-stage
        className="absolute top-0 left-0 inline-flex"
        style={
          shown && at
            ? { width: shown.width, height: shown.height, transform: `translate(${at.x}px, ${at.y}px)` }
            : { visibility: "hidden" }
        }
      >
        {placeholder && natural === null && (
          <img
            src={placeholder}
            alt=""
            aria-hidden="true"
            draggable={false}
            decoding="async"
            onLoad={(event) => setShape(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)}
            className="absolute inset-0 size-full max-w-none"
          />
        )}
        <img
          src={src}
          alt={alt}
          draggable={false}
          decoding="async"
          onLoad={(event) =>
            setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
          }
          className={`relative size-full max-w-none ${natural === null ? "opacity-0" : ""}`}
        />
        <span
          data-image-fallback
          className="absolute inset-0 items-center justify-center rounded-md bg-surface-raised text-4xl text-muted"
        >
          {initials}
        </span>
      </span>
    </div>
  )
}
