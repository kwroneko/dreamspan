// The cutout chooser (ARCHITECTURE.md §14.5c), as ST's avatar crop popup: a 2:3 box over the
// whole image, dragged and resized with a mouse or a finger, or moved and resized from the
// keyboard, with a live preview of the message portrait it makes. The image is never altered:
// what's saved is the box, as fractions of the image. The editor feature registers it as
// `portrait.cutout-chooser` (portraitParts.ts), so a plugin can replace it.
import { type AvatarCrop, cropPixels, defaultCrop, PORTRAIT_RATIO, snapCrop } from "@rp/shared/media.ts"
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef, useState } from "react"
import { Button } from "./Button.tsx"
import { Dialog, DialogActions } from "./Dialog.tsx"
import { IMAGES_SHORTCUT, useImagePrefs } from "./imagePrefs.ts"
import { type CutoutChooserProps, PICTURE_ACCEPT } from "./portraitParts.ts"
import { Spinner } from "./Spinner.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { initials } from "./Avatar.tsx"

/** The box in the image's own pixels; its height is always its width ÷ 2:3. */
interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
}
interface Size {
  readonly width: number
  readonly height: number
}

const heightOf = (box: Box) => box.width / PORTRAIT_RATIO
/** The largest box the image holds, and the smallest worth choosing (a twentieth, at least 8 px). */
const maxWidth = (image: Size) => Math.min(image.width, image.height * PORTRAIT_RATIO)
const minWidth = (image: Size) => Math.min(maxWidth(image), Math.max(8, maxWidth(image) / 20))

const clampBox = (box: Box, image: Size): Box => {
  const width = Math.max(minWidth(image), Math.min(maxWidth(image), box.width))
  return {
    width,
    left: Math.max(0, Math.min(image.width - width, box.left)),
    top: Math.max(0, Math.min(image.height - width / PORTRAIT_RATIO, box.top))
  }
}

const boxOf = (crop: AvatarCrop | null, image: Size): Box => {
  const pixels = cropPixels(crop ?? defaultCrop(image.width, image.height), image.width, image.height)
  return clampBox({ left: pixels.left, top: pixels.top, width: pixels.width }, image)
}

const cropOf = (box: Box, image: Size): AvatarCrop =>
  snapCrop({
    x: box.left / image.width,
    y: box.top / image.height,
    width: box.width / image.width,
    height: heightOf(box) / image.height
  })

/** Resized about its centre, by `factor`. */
const scaled = (box: Box, factor: number, image: Size) => {
  const width = Math.max(minWidth(image), Math.min(maxWidth(image), box.width * factor))
  const centreX = box.left + box.width / 2
  const centreY = box.top + heightOf(box) / 2
  return clampBox({ width, left: centreX - width / 2, top: centreY - width / PORTRAIT_RATIO / 2 }, image)
}

/** An image shown as a cutout of it in a 2:3 frame: the preview's portrait. */
export const cutoutStyle = (crop: AvatarCrop): CSSProperties => ({
  position: "absolute",
  maxWidth: "none",
  width: `${100 / crop.width}%`,
  height: `${100 / crop.height}%`,
  left: `${(-crop.x / crop.width) * 100}%`,
  top: `${(-crop.y / crop.height) * 100}%`
})

type Corner = "nw" | "ne" | "sw" | "se"
const CORNERS: ReadonlyArray<Corner> = ["nw", "ne", "sw", "se"]
const CORNER_CLASS: Record<Corner, string> = {
  nw: "-top-3 -left-3 cursor-nwse-resize",
  ne: "-top-3 -right-3 cursor-nesw-resize",
  sw: "-bottom-3 -left-3 cursor-nesw-resize",
  se: "-right-3 -bottom-3 cursor-nwse-resize"
}

interface Drag {
  readonly pointer: number
  readonly corner: Corner | null
  readonly startX: number
  readonly startY: number
  readonly start: Box
}

export function CutoutChooser({
  src,
  name,
  initial,
  title,
  saveLabel,
  pending,
  error,
  onSave,
  onCancel,
  onReplace
}: CutoutChooserProps) {
  const picker = useRef<HTMLInputElement>(null)
  const images = useImagePrefs()
  const [image, setImage] = useState<Size | null>(null)
  const [failed, setFailed] = useState(false)
  const [box, setBox] = useState<Box | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  const crop = image && box ? cropOf(box, image) : null

  /** Screen pixels to the image's pixels, from the shown image's width. */
  const scale = () => {
    const shown = stage.current?.getBoundingClientRect().width ?? 0
    return image && shown > 0 ? image.width / shown : 1
  }

  const startDrag = (event: PointerEvent<HTMLElement>, corner: Corner | null) => {
    if (!box || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    // The drag follows the pointer outside the box (a pointer the browser no longer tracks can't be captured).
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // The drag still follows moves over the box.
    }
    drag.current = { pointer: event.pointerId, corner, startX: event.clientX, startY: event.clientY, start: box }
  }

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId || !image) return
    const ratio = scale()
    const dx = (event.clientX - current.startX) * ratio
    const dy = (event.clientY - current.startY) * ratio
    const start = current.start
    if (current.corner === null) {
      setBox(clampBox({ ...start, left: start.left + dx, top: start.top + dy }, image))
      return
    }
    // A corner resizes the box about the opposite one, which stays put.
    const east = current.corner.endsWith("e")
    const south = current.corner.startsWith("s")
    const anchorX = east ? start.left : start.left + start.width
    const anchorY = south ? start.top : start.top + heightOf(start)
    const pointerX = (east ? start.left + start.width : start.left) + dx
    const pointerY = (south ? start.top + heightOf(start) : start.top) + dy
    const room = Math.min(
      east ? image.width - anchorX : anchorX,
      (south ? image.height - anchorY : anchorY) * PORTRAIT_RATIO
    )
    const wanted = Math.max(
      east ? pointerX - anchorX : anchorX - pointerX,
      (south ? pointerY - anchorY : anchorY - pointerY) * PORTRAIT_RATIO
    )
    const width = Math.max(minWidth(image), Math.min(room, maxWidth(image), wanted))
    setBox(
      clampBox(
        {
          width,
          left: east ? anchorX : anchorX - width,
          top: south ? anchorY : anchorY - width / PORTRAIT_RATIO
        },
        image
      )
    )
  }

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null
  }

  const grow = (factor: number) => image && box && setBox(scaled(box, factor, image))

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!image || !box) return
    const step = (event.shiftKey ? 0.1 : 0.01) * maxWidth(image)
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    }
    const move = moves[event.key]
    if (move) {
      event.preventDefault()
      setBox(clampBox({ ...box, left: box.left + move[0], top: box.top + move[1] }, image))
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      grow(1.05)
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault()
      grow(1 / 1.05)
    }
  }

  const percent = (value: number, of: number) => `${(value / of) * 100}%`
  const hidden = images.mode === "hide"

  return (
    <Dialog
      open
      wide
      closeButton
      onOpenChange={(open) => !open && !pending && onCancel()}
      // Focus starts on the image, not a button whose tooltip would cover Save on a phone.
      initialFocus={() => stage.current}
      title={title}
      description="The whole image is kept. The box is the part every small portrait shows: in messages, the cast, lists and tiles."
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
          <div
            ref={stage}
            tabIndex={-1}
            data-cutout-stage
            className="relative inline-block max-w-full touch-none outline-none select-none"
          >
            <img
              src={src}
              alt={`${name}'s whole image`}
              draggable={false}
              onLoad={(event) => {
                const node = event.currentTarget
                const size = { width: node.naturalWidth, height: node.naturalHeight }
                setImage(size)
                setBox(boxOf(initial, size))
              }}
              onError={() => setFailed(true)}
              className="block max-h-[min(60dvh,36rem)] max-w-full bg-surface-raised object-contain"
            />
            <span
              data-image-fallback
              className="absolute inset-0 items-center justify-center bg-surface-raised text-xs text-muted"
            >
              Image hidden
            </span>
            {image && box && (
              <>
                {/* The rest of the image, dimmed: four bands around the box. */}
                <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                  <div
                    className="absolute inset-x-0 top-0 bg-overlay"
                    style={{ height: percent(box.top, image.height) }}
                  />
                  <div
                    className="absolute inset-x-0 bottom-0 bg-overlay"
                    style={{ height: percent(image.height - box.top - heightOf(box), image.height) }}
                  />
                  <div
                    className="absolute left-0 bg-overlay"
                    style={{
                      top: percent(box.top, image.height),
                      height: percent(heightOf(box), image.height),
                      width: percent(box.left, image.width)
                    }}
                  />
                  <div
                    className="absolute right-0 bg-overlay"
                    style={{
                      top: percent(box.top, image.height),
                      height: percent(heightOf(box), image.height),
                      width: percent(image.width - box.left - box.width, image.width)
                    }}
                  />
                </div>
                <Tooltip label="Drag to move the cutout, or its corners to resize it. Arrow keys move it (Shift: further); + and − resize it.">
                  <div
                    role="slider"
                    tabIndex={0}
                    aria-label="Cutout"
                    aria-valuetext={`${Math.round((box.width / image.width) * 100)}% of the width, from ${Math.round((box.left / image.width) * 100)}% left and ${Math.round((box.top / image.height) * 100)}% down`}
                    aria-valuenow={Math.round((box.width / maxWidth(image)) * 100)}
                    aria-valuemin={Math.round((minWidth(image) / maxWidth(image)) * 100)}
                    aria-valuemax={100}
                    data-cutout-box
                    onKeyDown={onKey}
                    onPointerDown={(event) => startDrag(event, null)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={endDrag}
                    className="absolute cursor-move touch-none border-2 border-accent-contrast shadow-[0_0_0_1px_var(--color-accent)] outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
                    style={{
                      left: percent(box.left, image.width),
                      top: percent(box.top, image.height),
                      width: percent(box.width, image.width),
                      height: percent(heightOf(box), image.height)
                    }}
                  >
                    {CORNERS.map((corner) => (
                      <span
                        key={corner}
                        aria-hidden="true"
                        data-cutout-corner={corner}
                        data-layout-overlay="Resize handles sit on the cutout's corners"
                        onPointerDown={(event) => startDrag(event, corner)}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onLostPointerCapture={endDrag}
                        className={`absolute flex size-6 touch-none items-center justify-center ${CORNER_CLASS[corner]}`}
                      >
                        <span className="size-3 rounded-full border-2 border-accent bg-accent-contrast" />
                      </span>
                    ))}
                  </div>
                </Tooltip>
              </>
            )}
            {!image && !failed && (
              <div className="flex h-48 w-48 items-center justify-center">
                <Spinner />
              </div>
            )}
          </div>
          {failed && (
            <p role="alert" className="text-sm text-danger">
              The image couldn't be shown, so there's no cutout to choose.
            </p>
          )}
          <p className="text-center text-xs text-muted">
            Drag the box, or a corner to resize it. Keys: the arrows move it, + and − resize it.
          </p>
          {hidden && (
            <p className="text-center text-xs text-muted">
              Images are hidden, so you can't see what the box covers: show them ({IMAGES_SHORTCUT}) to choose.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:w-48">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">In a message</span>
            <div className="flex items-start gap-2 rounded-md border border-border bg-canvas p-2">
              <span
                data-cutout-preview
                className="chat-portrait relative inline-flex shrink-0 overflow-hidden rounded-sm bg-surface-raised"
              >
                {crop && <img src={src} alt="" draggable={false} style={cutoutStyle(crop)} />}
                <span
                  aria-hidden="true"
                  data-image-fallback
                  className="absolute inset-0 items-center justify-center text-lg font-semibold text-muted"
                >
                  {initials(name)}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{name}</span>
                <span className="mt-1 block h-2 w-full rounded-sm bg-surface-raised" />
                <span className="mt-1 block h-2 w-3/4 rounded-sm bg-surface-raised" />
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Tooltip label="Make the cutout smaller (−)">
              <Button disabled={!box} onClick={() => grow(1 / 1.1)} aria-label="Smaller cutout" aria-keyshortcuts="-">
                Smaller
              </Button>
            </Tooltip>
            <Tooltip label="Make the cutout larger (+)">
              <Button disabled={!box} onClick={() => grow(1.1)} aria-label="Larger cutout" aria-keyshortcuts="+">
                Larger
              </Button>
            </Tooltip>
            <Tooltip label="Put the box back where it starts for this image: the full width from the top, or the full height in the middle">
              <Button variant="ghost" disabled={!image} onClick={() => image && setBox(boxOf(null, image))}>
                Default
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <DialogActions>
        {onReplace && (
          <>
            <input
              ref={picker}
              type="file"
              accept={PICTURE_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose a new picture"
              data-replace-picker
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ""
                if (file) onReplace(file)
              }}
            />
            <Tooltip label="Replace the picture: choose another image, then its cutout. PNG, JPEG, GIF or WebP, up to 16 MB.">
              <Button variant="ghost" disabled={pending} className="sm:mr-auto" onClick={() => picker.current?.click()}>
                Replace picture…
              </Button>
            </Tooltip>
          </>
        )}
        <Tooltip label="Close without changing the portrait">
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </Tooltip>
        <Tooltip label="Save this cutout as the portrait's">
          <Button variant="primary" pending={pending} disabled={!crop} onClick={() => crop && onSave(crop)}>
            {saveLabel}
          </Button>
        </Tooltip>
      </DialogActions>
    </Dialog>
  )
}
