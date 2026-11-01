// A whole image in a box: fitted to it (enlarged up to MAX_UPSCALE, never more), or at a
// scale of its own (100%, or wherever a pinch left it) with dragging and scrolling to pan.
// Shared by the chat's portrait column and the phone's full-screen viewer.
import { useLayoutEffect, useRef, useState } from "react"

/** How far fitting enlarges a small image: past this, it's blur rather than detail. */
export const MAX_UPSCALE = 2
const MAX_ZOOM = 8

export type Zoom = "fit" | number

export interface NaturalSize {
  readonly width: number
  readonly height: number
}

/** The scale that shows all of an image in a box. */
const fitScale = (natural: NaturalSize, box: NaturalSize) =>
  Math.min(box.width / natural.width, box.height / natural.height, MAX_UPSCALE)

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
  /** The scale shown, for a label, and the original's own size once it's loaded. */
  onScale?: (scale: number, natural: NaturalSize | null) => void
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

  // Where to keep a point of the image under the same point of the box after a zoom.
  const anchor = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)
  const zoomTo = (next: Zoom, at?: { x: number; y: number }, image?: { fx: number; fy: number }) => {
    const node = box.current
    if (node && shown) {
      const x = at?.x ?? node.clientWidth / 2
      const y = at?.y ?? node.clientHeight / 2
      const left = Math.max(0, (node.clientWidth - shown.width) / 2)
      const top = Math.max(0, (node.clientHeight - shown.height) / 2)
      anchor.current = image
        ? { ...image, x, y }
        : { fx: (node.scrollLeft + x - left) / shown.width, fy: (node.scrollTop + y - top) / shown.height, x, y }
    }
    onZoom(next)
  }
  // A zoom from outside (the toolbar's Fit / 100%) keeps the point at the box's centre.
  const last = useRef<{ width: number; height: number; left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const node = box.current
    if (!node || !shown) return
    const before = last.current
    const left = Math.max(0, (node.clientWidth - shown.width) / 2)
    const top = Math.max(0, (node.clientHeight - shown.height) / 2)
    last.current = { width: shown.width, height: shown.height, left, top }
    let point = anchor.current
    anchor.current = null
    if (!point && before && (before.width !== shown.width || before.height !== shown.height)) {
      const x = node.clientWidth / 2,
        y = node.clientHeight / 2
      point = {
        fx: (node.scrollLeft + x - before.left) / before.width,
        fy: (node.scrollTop + y - before.top) / before.height,
        x,
        y
      }
    }
    if (!point) return
    node.scrollLeft = point.fx * shown.width - point.x
    node.scrollTop = point.fy * shown.height - point.y
  })
  const lastScale = useRef<string>("")
  useLayoutEffect(() => {
    if (scale === null) return
    const key = `${scale}:${natural?.width}x${natural?.height}`
    if (key === lastScale.current) return
    lastScale.current = key
    onScale?.(scale, natural)
  })

  // Pointers down: one drags the image about, two pinch it.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; scale: number } | null>(null)
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
  }
  return (
    <div
      ref={box}
      data-image-viewer
      data-zoom={zoom === "fit" ? "fit" : "scaled"}
      className={`relative size-full touch-none overflow-auto overscroll-contain select-none ${
        shown && size && (shown.width > size.width + 1 || shown.height > size.height + 1)
          ? "cursor-grab active:cursor-grabbing"
          : ""
      }`}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return
        pointers.current.set(event.pointerId, local(event))
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // A pointer the browser no longer has (lifted already): nothing to follow.
        }
        const two = spread()
        if (two && scale !== null) pinch.current = { distance: two.distance, scale }
      }}
      onPointerMove={(event) => {
        const before = pointers.current.get(event.pointerId)
        if (!before) return
        const now = local(event)
        pointers.current.set(event.pointerId, now)
        const two = spread()
        if (pinch.current && two && two.distance > 0) {
          const next = Math.min(
            MAX_ZOOM,
            Math.max(Math.min(fit ?? 1, 1), (pinch.current.scale * two.distance) / pinch.current.distance)
          )
          zoomTo(next, two.mid)
        } else if (!pinch.current) {
          const node = event.currentTarget
          node.scrollLeft -= now.x - before.x
          node.scrollTop -= now.y - before.y
        }
      }}
      onPointerUp={(event) => release(event.pointerId)}
      onPointerCancel={(event) => release(event.pointerId)}
      onLostPointerCapture={(event) => release(event.pointerId)}
      onDoubleClick={(event) => {
        // The toolbar's Fit / 100% button does the same; this is its shortcut at the pointer.
        if (!shown) return
        const at = local(event)
        const left = Math.max(0, (event.currentTarget.clientWidth - shown.width) / 2)
        const top = Math.max(0, (event.currentTarget.clientHeight - shown.height) / 2)
        const image = {
          fx: Math.min(1, Math.max(0, (event.currentTarget.scrollLeft + at.x - left) / shown.width)),
          fy: Math.min(1, Math.max(0, (event.currentTarget.scrollTop + at.y - top) / shown.height))
        }
        zoomTo(zoom === "fit" ? 1 : "fit", at, image)
      }}
    >
      <div
        className="flex min-h-full min-w-full items-center justify-center"
        style={shown ? { width: shown.width, height: shown.height } : undefined}
      >
        <span
          className="relative inline-flex shrink-0"
          style={shown ? { width: shown.width, height: shown.height } : undefined}
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
    </div>
  )
}
