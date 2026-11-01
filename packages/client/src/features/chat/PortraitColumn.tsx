// The portrait column: a card's whole image in a column of its own left of the messages, as
// ST's zoomed avatar sits in the gap left of its chat. The chat stays readable, scrollable and
// sendable beside it. Its width follows the image (all of it at the column's height, a small
// one enlarged at most MAX_UPSCALE times) unless the user resized it, and gives way with the
// other columns so the messages keep their minimum (ui/columnLayout.ts).
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useSession } from "../../session.ts"
import { MAX_UPSCALE, type NaturalSize } from "../../ui/ImageViewer.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { popupOpen } from "../../ui/openPopups.ts"
import { PortraitView, usePortraitViewer } from "../../ui/Portrait.tsx"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"

const MIN = 200
/** Room around the image: its box's padding and the column's border. */
const GUTTER = 17

export function PortraitColumn({ wide }: { wide: boolean }) {
  const viewer = usePortraitViewer()
  if (!wide || !viewer?.shown) return null
  return <Column key={viewer.shown.id} />
}

function Column() {
  const viewer = usePortraitViewer()!
  const portrait = viewer.shown!
  const userId = useSession().user.id
  const ref = useRef<HTMLElement>(null)
  // The original's shape, from the thumbnail first, and the image box's height: what a
  // fitted image's height is.
  const [shape, setShape] = useState<NaturalSize | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    // The image's box, below the toolbar.
    const body = node?.querySelector<HTMLElement>("[data-image-viewer]") ?? node
    if (!body) return
    const observer = new ResizeObserver(() => setHeight(body.clientHeight))
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
  // Escape closes it from anywhere on the chat page, after anything focused has had it (a
  // menu, a popup, an editor's own Escape), and never while typing or over a dialog.
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
  const natural = useNatural(portrait.mediaId)
  const fitted = Math.round(
    height !== null && shape
      ? Math.min(height * (shape.width / shape.height), (natural?.width ?? Infinity) * MAX_UPSCALE) + GUTTER
      : 2 * ((height ?? 600) / 3) + GUTTER
  )
  // The user's width when they dragged its edge, else the image's; it gives way first, before
  // the sidebar and the side panel, so the messages keep their minimum (ui/columnLayout.ts).
  const { width, max, change, reset } = usePanelWidth(userId, "portrait", fitted, MIN, true, 1)
  return (
    <aside
      ref={ref}
      aria-label={`${portrait.name}'s portrait`}
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
      <PortraitView
        portrait={portrait}
        title={(name) => <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</h2>}
        close={<IconButton label="Close the portrait" icon="close" className="shrink-0" onClick={viewer.close} />}
      />
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
