// The portrait column: cards' whole images in a column of their own left of the messages, as
// ST's zoomed avatar sits in the gap left of its chat. The chat stays readable, scrollable and
// sendable beside it. Several stack, the newest on top (owner, 2026-11-02), each with its own
// header and a share of the fixed height split by dragging the boundary between two. Its width follows the images (the widest one's
// at its own box's height, a small one enlarged at most MAX_UPSCALE times) unless the user
// resized it, and gives way with the other columns so the messages keep their minimum
// (ui/columnLayout.ts). In the workbench it is a column of the shell, left of the frames, as the
// side panel is right of them (owner, 2026-11-05: "the image-viewer would also open in its own
// extra column as it does"): never inside a frame, where it would cover the next one.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useSession } from "../../session.ts"
import { MAX_UPSCALE, type NaturalSize } from "../../ui/ImageViewer.tsx"
import { mediaUrl, pictureUrl } from "../../ui/mediaImage.ts"
import { popupOpen } from "../../ui/openPopups.ts"
import { type Portrait, PortraitView, usePortraitViewer } from "../../ui/Portrait.tsx"
import type { StackEntry } from "../../ui/portraitStack.ts"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { ViewerHeader, ViewerMoves } from "../../ui/ViewerHeader.tsx"
import { Menu, MenuCheckboxItem } from "../../ui/Menu.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { usePortraitColumnPlace } from "../workbench/tab.tsx"

const MIN = 200
/** Preferred minimum while sharing a pair; smaller pairs split their available height. */
const MIN_VIEWER_HEIGHT = 180
/** Room around the image: its box's padding and the column's border. */
const GUTTER = 17

const SINGLE = "Keep one image open"
const SINGLE_OFF = "Click to keep only one image open at a time."
const SINGLE_ON = "Click to allow multiple images open at a time."

interface Measured {
  /** The viewer's height, header included. */
  readonly height: number
  /** The column width that shows all of its image at its box's height. */
  readonly fitted: number
}

export function PortraitColumn({ wide }: { wide: boolean }) {
  const viewer = usePortraitViewer()
  const place = usePortraitColumnPlace(wide && viewer !== null && viewer.shown.length > 0)
  if (!place.show) return null
  return place.host ? createPortal(<Column />, place.host) : <Column />
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                    min={Math.min(MIN_VIEWER_HEIGHT, pair / 2)}
                    max={Math.max(pair / 2, pair - MIN_VIEWER_HEIGHT)}
                    direction={1}
                    onChange={(upper) => viewer.split(index, upper, pair, Math.min(MIN_VIEWER_HEIGHT, pair / 2))}
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
    probe.src = portrait.picture ? pictureUrl(portrait.mediaId, portrait.picture) : mediaUrl(portrait.mediaId, 768)
    return () => {
      live = false
    }
  }, [portrait.mediaId, portrait.picture])
  const natural = useNatural(portrait.mediaId === null ? null : pictureUrl(portrait.mediaId, portrait.picture))
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
      style={{ flex: `${entry.weight} 1 0px`, minHeight: 0 }}
      className={`relative flex flex-col ${first ? "" : "border-t border-border"}`}
    >
      <PortraitView
        portrait={portrait}
        alignToChatHeader={first}
        header={(node) => <ViewerHeader portrait={portrait}>{node}</ViewerHeader>}
        title={(name) => <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</h2>}
        toggle={
          <Menu
            label="Viewer options"
            trigger={
              <IconButton
                label="Viewer options"
                icon="more"
                hint="Move this image or choose whether other images stay open."
              />
            }
          >
            <ViewerMoves portrait={portrait} />
            <MenuCheckboxItem
              icon="one-image"
              checked={viewer.single}
              onCheckedChange={(on) => viewer.setSingle(on, portrait.id)}
              description={viewer.single ? SINGLE_ON : SINGLE_OFF}
            >
              {SINGLE}
            </MenuCheckboxItem>
          </Menu>
        }
        close={<IconButton label="Close the portrait" icon="close" onClick={() => viewer.close(portrait.id)} />}
      />
      {boundary}
    </aside>
  )
}

/** The original's own pixels, which bound how far fitting may enlarge it. */
function useNatural(src: string | null) {
  const [natural, setNatural] = useState<NaturalSize | null>(null)
  useLayoutEffect(() => {
    if (src === null) return
    let live = true
    const probe = new Image()
    probe.onload = () => live && setNatural({ width: probe.naturalWidth, height: probe.naturalHeight })
    probe.src = src
    return () => {
      live = false
    }
  }, [src])
  return natural
}
