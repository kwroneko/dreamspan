// The portrait column: a card's whole image in a column of its own left of the messages, as
// ST's zoomed avatar sits in the gap left of its chat. The chat stays readable, scrollable and
// sendable beside it. Its width follows the image (all of it at the column's height, a small
// one enlarged at most MAX_UPSCALE times) unless the user resized it, and gives way so the
// messages keep CHAT_MIN; the side panel keeps its own width.
import { useLayoutEffect, useRef, useState } from "react"
import { useSession } from "../../session.ts"
import { MAX_UPSCALE, type NaturalSize } from "../../ui/ImageViewer.tsx"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { PortraitView, usePortraitViewer } from "../../ui/Portrait.tsx"
import { ResizeHandle } from "../../ui/ResizeHandle.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"

/** What the messages keep beside it. */
export const CHAT_MIN = 440
const MIN = 200
/** Room around the image: its box's padding and the column's border. */
const GUTTER = 17

const widthKey = (userId: string) => `rp.panelWidth.${userId}.portrait`
const readWidth = (userId: string) => {
  try {
    const value = Number(localStorage.getItem(widthKey(userId)))
    return value >= MIN ? value : null
  } catch {
    return null
  }
}

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
  const [saved, setSaved] = useState(() => readWidth(userId))
  // The original's shape, from the thumbnail first, and the room: the image box's height, and
  // the width this column and the messages share.
  const [shape, setShape] = useState<NaturalSize | null>(null)
  const [room, setRoom] = useState<{ height: number; shared: number } | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    const main = node?.parentElement?.querySelector<HTMLElement>(":scope > [data-chat-main]")
    // The image's box, below the toolbar: what a fitted image's height is.
    const body = node?.querySelector<HTMLElement>("[data-image-viewer]") ?? node
    if (!node || !main || !body) return
    const measure = () =>
      setRoom({
        height: body.clientHeight,
        shared: node.getBoundingClientRect().width + main.getBoundingClientRect().width
      })
    const observer = new ResizeObserver(measure)
    observer.observe(node.parentElement!)
    observer.observe(main)
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
  const max = room ? Math.max(MIN, room.shared - CHAT_MIN) : 560
  const natural = useNatural(portrait.mediaId)
  const fitted =
    room && shape
      ? Math.min(room.height * (shape.width / shape.height), (natural?.width ?? Infinity) * MAX_UPSCALE) + GUTTER
      : 2 * ((room?.height ?? 600) / 3) + GUTTER
  const width = Math.round(Math.max(MIN, Math.min(max, saved ?? fitted)))
  const change = (next: number) => {
    const value = Math.max(MIN, Math.min(max, next))
    setSaved(value)
    try {
      localStorage.setItem(widthKey(userId), String(value))
    } catch {
      /* In memory when storage is off. */
    }
  }
  const reset = () => {
    setSaved(null)
    try {
      localStorage.removeItem(widthKey(userId))
    } catch {
      /* In memory when storage is off. */
    }
  }
  return (
    <aside
      ref={ref}
      aria-label={`${portrait.name}'s portrait`}
      data-portrait-column
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-border bg-surface"
      // Escape closes it while focus is in it; elsewhere Escape is the chat's.
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) viewer.close()
      }}
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
