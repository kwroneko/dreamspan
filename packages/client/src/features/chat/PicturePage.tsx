// A picture in a workbench tab of its own (owner, 2026-11-07: "it should be possible to drag the
// image viewers into frames, as tabs, but they should still open in their column by default").
// The tab's URL names the picture (its media, its name, its cutout), so it closes, moves,
// splits and comes back after a reload as any tab does. The viewer is the column's
// (`PortraitView`): its zoom, Fit and 100%, the wheel, a drag and a pinch.
import { useSearch } from "@tanstack/react-router"
import { cropKey, parseCropKey } from "@rp/shared/media.ts"
import { useTitle } from "../shell.tsx"
import { type Portrait, PortraitView } from "../../ui/Portrait.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { useWorkbenchTab } from "../workbench/tab.tsx"

export const PICTURE_PATH = "/picture"

/** The tab URL of a portrait's picture; null for a card without an image. */
export const pictureHref = (portrait: Portrait) => {
  if (portrait.mediaId === null) return null
  const params = new URLSearchParams({ media: portrait.mediaId, name: portrait.name })
  if (portrait.picture) params.set("crop", cropKey(portrait.picture))
  if (portrait.image) params.set("image", "1")
  return `${PICTURE_PATH}?${params.toString()}`
}

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : null)

/** The picture a tab URL names. */
const pictureOf = (search: Record<string, unknown>): Portrait | null => {
  const media = text(search["media"])
  if (!media) return null
  const crop = text(search["crop"])
  const picture = crop === null ? undefined : (parseCropKey(crop) ?? undefined)
  return {
    id: `picture:${media}`,
    name: text(search["name"]) || "Picture",
    mediaId: media,
    picture,
    ...(text(search["image"]) === "1" ? { image: true as const } : {})
  }
}

export function PicturePage() {
  const search: Record<string, unknown> = useSearch({ strict: false })
  const portrait = pictureOf(search)
  const tab = useWorkbenchTab()
  const name = portrait?.name ?? "Picture"
  useTitle(name)
  return (
    <section
      aria-label={`${name}'s picture`}
      data-picture-tab
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
    >
      {portrait ? (
        <PortraitView
          portrait={portrait}
          title={(shown) => <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{shown}</h1>}
          close={
            tab && (
              <IconButton
                label="Close the picture"
                hint="Closes this picture's tab."
                icon="close"
                onClick={() => tab.store.close(tab.tabId)}
              />
            )
          }
        />
      ) : (
        <p className="p-6 text-sm text-muted">This link names no picture.</p>
      )}
    </section>
  )
}
