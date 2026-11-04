// The cutout chooser (ARCHITECTURE.md §14.5c), as ST's avatar crop popup: a 2:3 box over the
// whole image, dragged and resized with a mouse or a finger, or moved and resized from the
// keyboard, with live message, cast and tile previews. The image is never altered:
// what's saved is the box, as fractions of the image. The editor feature registers it as
// `portrait.cutout-chooser` (portraitParts.ts), so a plugin can replace it.
import { type AvatarCrop, cropPixels, defaultCrop, PORTRAIT_RATIO, snapCrop, WHOLE_PICTURE } from "@rp/shared/media.ts"
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef, useState } from "react"
import { Segmented } from "./Segmented.tsx"
import { Button } from "./Button.tsx"
import { Dialog } from "./Dialog.tsx"
import { AboutHint } from "./AboutHint.tsx"
import { Icon } from "./Icon.tsx"
import { ToolbarSlider } from "./Slider.tsx"
import { IMAGES_SHORTCUT, useImagePrefs } from "./imagePrefs.ts"
import { type CutoutChooserProps, PICTURE_ACCEPT } from "./portraitParts.ts"
import { Spinner } from "./Spinner.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { AVATAR_SIZES, initials } from "./Avatar.tsx"

interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}
interface Size {
  readonly width: number
  readonly height: number
}
const heightOf = (box: Box) => box.height
const cropOf = (box: Box, image: Size): AvatarCrop =>
  snapCrop({
    x: box.left / image.width,
    y: box.top / image.height,
    width: box.width / image.width,
    height: box.height / image.height
  })
const boxFrom = (crop: AvatarCrop, image: Size): Box => ({
  left: crop.x * image.width,
  top: crop.y * image.height,
  width: crop.width * image.width,
  height: crop.height * image.height
})

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
const CUTOUT_HELP = "Drag the box to move it, or a corner to resize it. Arrow keys move it; + and − resize it."

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
  const [tab, setTab] = useState("picture")
  const [preset, setPreset] = useState("free")
  const [picture, setPicture] = useState<AvatarCrop>(initial?.picture ?? WHOLE_PICTURE)
  const [portrait, setPortrait] = useState<AvatarCrop | null>(initial)
  const [box, setBox] = useState<Box | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  const crop = image && box ? cropOf(box, image) : null
  const bounds = image ? boxFrom(tab === "picture" ? WHOLE_PICTURE : picture, image) : null
  const ratio = tab === "portrait" || preset === "portrait" ? PORTRAIT_RATIO : preset === "square" ? 1 : null
  const maxWidth = (size: Size) => {
    const area = bounds ?? { width: size.width, height: size.height }
    return ratio
      ? Math.min(area.width, area.height * ratio)
      : Math.min(area.width, area.height * (box ? box.width / box.height : size.width / size.height))
  }
  const minWidth = (size: Size) => Math.min(maxWidth(size), Math.max(1, maxWidth(size) / 20))
  const clampBox = (chosen: Box, size: Size): Box => {
    const area = bounds ?? { left: 0, top: 0, width: size.width, height: size.height }
    const width = Math.max(1, Math.min(area.width, chosen.width))
    const height = Math.max(1, Math.min(area.height, chosen.height))
    return {
      width,
      height,
      left: Math.max(area.left, Math.min(area.left + area.width - width, chosen.left)),
      top: Math.max(area.top, Math.min(area.top + area.height - height, chosen.top))
    }
  }
  const scaled = (chosen: Box, factor: number, size: Size): Box => {
    const shape = ratio ?? chosen.width / chosen.height
    const area = bounds ?? { width: size.width, height: size.height }
    const width = Math.max(minWidth(size), Math.min(area.width, area.height * shape, chosen.width * factor))
    const height = width / shape
    return clampBox(
      { width, height, left: chosen.left + (chosen.width - width) / 2, top: chosen.top + (chosen.height - height) / 2 },
      size
    )
  }
  const defaultPortrait = (cut: AvatarCrop, size: Size) => {
    const inner = defaultCrop(cut.width * size.width, cut.height * size.height)
    return {
      x: cut.x + inner.x * cut.width,
      y: cut.y + inner.y * cut.height,
      width: inner.width * cut.width,
      height: inner.height * cut.height
    }
  }
  const switchTab = (next: string) => {
    if (!image || !crop || next === tab) return
    if (tab === "picture") {
      setPicture(crop)
      const kept =
        portrait &&
        portrait.x >= crop.x &&
        portrait.y >= crop.y &&
        portrait.x + portrait.width <= crop.x + crop.width &&
        portrait.y + portrait.height <= crop.y + crop.height
          ? portrait
          : defaultPortrait(crop, image)
      setPortrait(kept)
      setBox(cropPixels(kept, image.width, image.height))
    } else {
      setPortrait(crop)
      setBox(boxFrom(picture, image))
    }
    setTab(next)
  }
  const choosePreset = (next: string) => {
    setPreset(next)
    if (!box || !image || next === "free") return
    const shape = next === "square" ? 1 : PORTRAIT_RATIO
    const width = Math.min(box.width, box.height * shape)
    const height = width / shape
    setBox({ width, height, left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2 })
  }
  const save = () => {
    if (!image || !crop) return
    const cut = tab === "picture" ? crop : picture
    const kept = tab === "portrait" ? crop : portrait
    const chosen =
      kept &&
      kept.x >= cut.x &&
      kept.y >= cut.y &&
      kept.x + kept.width <= cut.x + cut.width &&
      kept.y + kept.height <= cut.y + cut.height
        ? kept
        : defaultPortrait(cut, image)
    onSave({
      ...snapCrop({ x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height }),
      ...(cut.x || cut.y || cut.width !== 1 || cut.height !== 1 ? { picture: snapCrop(cut) } : {})
    })
  }

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
    const screenScale = scale()
    const dx = (event.clientX - current.startX) * screenScale
    const dy = (event.clientY - current.startY) * screenScale
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
    const area = bounds!
    const roomX = east ? area.left + area.width - anchorX : anchorX - area.left
    const roomY = south ? area.top + area.height - anchorY : anchorY - area.top
    let width = Math.max(1, Math.min(roomX, east ? pointerX - anchorX : anchorX - pointerX))
    let height = Math.max(1, Math.min(roomY, south ? pointerY - anchorY : anchorY - pointerY))
    if (ratio) {
      width = Math.max(1, Math.min(roomX, roomY * ratio, Math.max(width, height * ratio)))
      height = width / ratio
    }
    setBox(
      clampBox(
        { width, height, left: east ? anchorX : anchorX - width, top: south ? anchorY : anchorY - height },
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
      onOpenChange={(open) => !open && !pending && onCancel()}
      // Focus starts on the image, not a button whose tooltip would cover Save on a phone.
      initialFocus={() => stage.current}
      title={title}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Picture settings"
          inlineDescription={false}
          value={tab}
          onValueChange={switchTab}
          options={[
            {
              value: "picture",
              label: "Picture",
              description: "Click to choose the picture shown in large views and exports"
            },
            {
              value: "portrait",
              label: "Portrait",
              description: "Click to choose the small portrait inside the picture"
            }
          ]}
        />
        {tab === "picture" && (
          <Segmented
            label="Crop shape"
            inlineDescription={false}
            value={preset}
            onValueChange={choosePreset}
            options={[
              { value: "free", label: "Free", description: "Click to crop to any rectangular shape" },
              { value: "portrait", label: "2:3", description: "Click to crop two wide by three high" },
              { value: "square", label: "1:1", description: "Click to crop a square" }
            ]}
          />
        )}
      </div>
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
                setBox(boxFrom(initial?.picture ?? WHOLE_PICTURE, size))
              }}
              onError={() => setFailed(true)}
              className="block max-h-[min(36dvh,36rem)] max-w-full bg-surface-raised object-contain sm:max-h-[min(60dvh,36rem)]"
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
                <div
                  aria-hidden="true"
                  data-layout-overlay="The mask dims the original outside the selected cut"
                  className="pointer-events-none absolute inset-0"
                >
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
                <Tooltip label={CUTOUT_HELP}>
                  <div
                    role="slider"
                    tabIndex={0}
                    aria-label="Cutout"
                    aria-valuetext={`${Math.round((box.width / image.width) * 100)}% of the width, from ${Math.round((box.left / image.width) * 100)}% left and ${Math.round((box.top / image.height) * 100)}% down`}
                    aria-valuenow={Math.round((box.width / maxWidth(image)) * 100)}
                    aria-valuemin={Math.round((minWidth(image) / maxWidth(image)) * 100)}
                    aria-valuemax={100}
                    data-cutout-box
                    data-layout-overlay="The movable crop box marks the selected region over the original"
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
          <div data-cutout-controls className="flex w-full max-w-sm items-center justify-center gap-2">
            <span className="shrink-0 text-xs text-muted">Cutout size</span>
            <ToolbarSlider
              label="Cutout size"
              hint={image ? "Resize the cutout" : "The picture must load before resizing the cutout"}
              value={box?.width ?? 0}
              min={image ? minWidth(image) : 0}
              max={image ? maxWidth(image) : 1}
              step={image ? maxWidth(image) / 1000 : 1}
              valueText={(value) => `${Math.round(image ? (value / maxWidth(image)) * 100 : 0)}% of the largest cutout`}
              disabled={!box}
              className="min-w-0 flex-1"
              onValueChange={(width) => image && box && setBox(scaled(box, width / box.width, image))}
            />
            <Button
              variant="ghost"
              className="size-8 px-0!"
              aria-label={tab === "picture" ? "Reset to the original" : "Reset the cutout"}
              hint={
                image
                  ? tab === "picture"
                    ? "Reset to the original picture and its default portrait"
                    : "Reset the portrait inside the picture"
                  : "The picture must load before resetting the cutout"
              }
              disabled={!image}
              onClick={() => {
                if (!image) return
                if (tab === "picture") {
                  setPicture(WHOLE_PICTURE)
                  setPortrait(null)
                  setPreset("free")
                  setBox(boxFrom(WHOLE_PICTURE, image))
                } else setBox(boxFrom(defaultPortrait(picture, image), image))
              }}
            >
              <Icon name="regenerate" size={16} />
            </Button>
            <AboutHint heading="cutout controls">{CUTOUT_HELP}</AboutHint>
          </div>
          {hidden && (
            <p className="text-center text-xs text-muted">
              Images are hidden, so you can't see what the box covers: show them ({IMAGES_SHORTCUT}) to choose.
            </p>
          )}
        </div>
        <section aria-label="Previews" className="flex shrink-0 flex-col gap-2">
          <h3 className="text-sm font-medium">Previews</h3>
          <div className="flex items-start gap-4 sm:flex-col">
            {(tab === "picture"
              ? [
                  ["Large view", "w-[134px]"],
                  ["Export", "w-[96px]"]
                ]
              : [
                  ["Message", AVATAR_SIZES.chat],
                  ["Cast", AVATAR_SIZES.chip],
                  // The 8.5rem minimum library/home tile has a 1px border on each side.
                  ["Tile", "h-[201px] w-[134px]"]
                ]
            ).map(([label, size]) => (
              <div key={label} className="flex flex-col items-start gap-1.5">
                <span className="text-xs text-muted">{label}</span>
                <span
                  data-cutout-preview={label}
                  className={`relative inline-flex shrink-0 overflow-hidden rounded-sm bg-surface-raised ${size}`}
                  style={
                    tab === "picture" && crop && image
                      ? { aspectRatio: `${crop.width * image.width} / ${crop.height * image.height}` }
                      : undefined
                  }
                >
                  {crop && <img src={src} alt="" draggable={false} style={cutoutStyle(crop)} />}
                  <span
                    aria-hidden="true"
                    data-image-fallback
                    className="absolute inset-0 items-center justify-center font-semibold text-muted"
                  >
                    {initials(name)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div data-cutout-actions className="flex flex-wrap items-center justify-end gap-2">
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
            <Tooltip label="Choose a replacement picture and its cutout. PNG, JPEG, GIF or WebP, up to 16 MB.">
              <Button
                variant="secondary"
                disabled={pending}
                className="mr-auto"
                onClick={() => picker.current?.click()}
              >
                Replace picture…
              </Button>
            </Tooltip>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Tooltip label="Close without changing the picture">
            <Button variant="secondary" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          </Tooltip>
          <Tooltip label="Save the picture and portrait cuts">
            <Button
              variant="primary"
              className="relative [&>svg]:absolute"
              pending={pending}
              disabled={!crop}
              onClick={save}
            >
              <span className={pending ? "opacity-0" : undefined}>{saveLabel}</span>
            </Button>
          </Tooltip>
        </div>
      </div>
    </Dialog>
  )
}
