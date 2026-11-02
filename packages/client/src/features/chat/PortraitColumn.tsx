// The portrait column: cards' whole images in a column of their own left of the messages, as
// ST's zoomed avatar sits in the gap left of its chat. The chat stays readable, scrollable and
// sendable beside it. Several stack, the newest on top (owner, 2026-11-02), each with its own
// header and a share of the height split by dragging the boundary between two; past what fits
// at their minimum height the column scrolls. Its width follows the images (the widest one's
// at its own box's height, a small one enlarged at most MAX_UPSCALE times) unless the user
// resized it, and gives way with the other columns so the messages keep their minimum
// (ui/columnLayout.ts).
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useSession } from "../../session.ts"
import { MAX_UPSCALE, type NaturalSize } from "../../ui/ImageViewer.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { popupOpen } from "../../ui/openPopups.ts"
import { type Portrait, PortraitView, usePortraitViewer } from "../../ui/Portrait.tsx"
import type { StackEntry } from "../../ui/portraitStack.ts"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"

const MIN = 200
/** The least a viewer is high, its header included; below it, the column scrolls. */
const MIN_VIEWER_HEIGHT = 180
/** Room around the image: its box's padding and the column's border. */
const GUTTER = 17

const SINGLE = "Only keep one image open at a time"
const SINGLE_OFF = `${SINGLE}. Closes the other images; another portrait then replaces this one.`
const SINGLE_ON = `${SINGLE} (on). Turn it off to open images on top of each other.`

interface Measured {
  /** The viewer's height, header included. */
  readonly height: number
  /** The column width that shows all of its image at its box's height. */
  readonly fitted: number
}

export function PortraitColumn({ wide }: { wide: boolean }) {
  const viewer = usePortraitViewer()
  if (!wide || !viewer || viewer.shown.length === 0) return null
  return <Column />
}

function Column() {
  const viewer = usePortraitViewer()!
  const shown = viewer.shown
  const userId = useSession().user.id
  const [measured, setMeasured] = useState<Readonly<Record<string, Measured>>>({})
  // Escape closes the top one from anywhere on the chat page, after anything focused has had
  // it (a menu, a popup, an editor's own Escape), and never while typing or over a dialog.
  const close = viewer.close
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return
      if (popupOpen(["dialog", "alertdialog", "menu", "listbox"])) return
      close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [close])
  const fits = shown.flatMap((entry) => {
    const fitted = measured[entry.portrait.id]?.fitted
    return fitted === undefined ? [] : [fitted]
  })
  const fitted = fits.length > 0 ? Math.max(...fits) : Math.round(2 * (600 / 3) + GUTTER)
  // The user's width when they dragged its edge, else the widest image's; it gives way first,
  // before the sidebar and the side panel, so the messages keep their minimum (ui/columnLayout.ts).
  const { width, max, change, reset } = usePanelWidth(userId, "portrait", fitted, MIN, true, 1)
  const name = (index: number) => shown[index]?.portrait.name ?? ""
  return (
    <div
      data-portrait-column
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-border bg-surface"
    >
      <ResizeHandle
        label="Resize the portrait"
        width={width}
        min={MIN}
        max={max}
        direction={1}
        onChange={change}
        onReset={reset}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {shown.map((entry, index) => {
          const below = shown[index + 1]
          const height = measured[entry.portrait.id]?.height
          const pair = below && height !== undefined ? height + (measured[below.portrait.id]?.height ?? 0) : null
          return (
            <Viewer
              key={entry.portrait.id}
              entry={entry}
              first={index === 0}
              onMeasure={(size) =>
                setMeasured((all) => {
                  const was = all[entry.portrait.id]
                  return was?.height === size.height && was.fitted === size.fitted
                    ? all
                    : { ...all, [entry.portrait.id]: size }
                })
              }
              boundary={
                below &&
                height !== undefined &&
                pair !== null && (
                  <ResizeHandle
                    label={`Resize ${name(index)}'s and ${name(index + 1)}'s portraits`}
                    axis="y"
                    width={height}
                    min={MIN_VIEWER_HEIGHT}
                    max={Math.max(MIN_VIEWER_HEIGHT, pair - MIN_VIEWER_HEIGHT)}
                    direction={1}
                    onChange={(upper) => viewer.split(index, upper, pair, MIN_VIEWER_HEIGHT)}
                    onReset={() => viewer.even(index)}
                  />
                )
              }
            />
          )
        })}
      </div>
    </div>
  )
}

/** One portrait in the stack: its header (name, scale, Fit / 100%, the toggle, Close) over its image. */
function Viewer({
  entry,
  first,
  boundary,
  onMeasure
}: {
  entry: StackEntry<Portrait>
  first: boolean
  boundary: ReactNode
  onMeasure: (size: Measured) => void
}) {
  const viewer = usePortraitViewer()!
  const portrait = entry.portrait
  const ref = useRef<HTMLElement>(null)
  // The original's shape, from the thumbnail first, and the image box's height: what a
  // fitted image's height is.
  const [shape, setShape] = useState<NaturalSize | null>(null)
  const [size, setSize] = useState<{ height: number; box: number } | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    // The image's box, below the header.
    const body = node.querySelector<HTMLElement>("[data-image-viewer]") ?? node
    const observer = new ResizeObserver(() =>
      setSize({ height: node.getBoundingClientRect().height, box: body.clientHeight })
    )
    observer.observe(node)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (portrait.mediaId === null) return
    let live = true
    const probe = new Image()
    probe.onload = () => live && setShape({ width: probe.naturalWidth, height: probe.naturalHeight })
    // The thumbnail has the original's shape; its own size says nothing of the original's.
    probe.src = mediaUrl(portrait.mediaId, 768)
    return () => {
      live = false
    }
  }, [portrait.mediaId])
  const natural = useNatural(portrait.mediaId)
  const box = size?.box ?? null
  const fitted = Math.round(
    box !== null && shape
      ? Math.min(box * (shape.width / shape.height), (natural?.width ?? Infinity) * MAX_UPSCALE) + GUTTER
      : 2 * ((box ?? 600) / 3) + GUTTER
  )
  const height = size?.height
  useLayoutEffect(() => {
    if (height !== undefined) onMeasure({ height, fitted })
  })
  return (
    <aside
      ref={ref}
      aria-label={`${portrait.name}'s portrait`}
      data-portrait-viewer
      style={{ flex: `${entry.weight} 1 0px`, minHeight: MIN_VIEWER_HEIGHT }}
      className={`relative flex flex-col ${first ? "" : "border-t border-border"}`}
    >
      <PortraitView
        portrait={portrait}
        title={(name) => <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</h2>}
        close={
          <>
            <IconButton
              label={SINGLE}
              hint={viewer.single ? SINGLE_ON : SINGLE_OFF}
              icon="one-image"
              aria-pressed={viewer.single}
              className="aria-pressed:bg-surface-raised aria-pressed:text-accent aria-pressed:ring-1 aria-pressed:ring-border"
              onClick={() => viewer.setSingle(!viewer.single, portrait.id)}
            />
            <IconButton label="Close the portrait" icon="close" onClick={() => viewer.close(portrait.id)} />
          </>
        }
      />
      {boundary}
    </aside>
  )
}

/** The original's own pixels, which bound how far fitting may enlarge it. */
function useNatural(mediaId: string | null) {
  const [natural, setNatural] = useState<NaturalSize | null>(null)
  useLayoutEffect(() => {
    if (mediaId === null) return
    let live = true
    const probe = new Image()
    probe.onload = () => live && setNatural({ width: probe.naturalWidth, height: probe.naturalHeight })
    probe.src = mediaUrl(mediaId)
    return () => {
      live = false
    }
  }, [mediaId])
  return natural
}
