// A picture in a workbench tab of its own (owner, 2026-11-07: "it should be possible to drag the
// image viewers into frames, as tabs, but they should still open in their column by default").
// The tab's URL names the picture (its media, its name, its cutout), so it closes, moves,
// splits and comes back after a reload as any tab does. The viewer is the column's
// (`PortraitView`): its zoom, Fit and 100%, the wheel, a drag and a pinch.
import { useRouter } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import { cropKey, parseCropKey } from "@dreamspan/shared/media.ts"
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

/** The picture a tab URL names. */
const pictureOf = (search: URLSearchParams): Portrait | null => {
  const media = search.get("media")
  if (!media) return null
  const crop = search.get("crop")
  const picture = crop === null ? undefined : (parseCropKey(crop) ?? undefined)
  return {
    id: `picture:${media}`,
    name: search.get("name") || "Picture",
    mediaId: media,
    picture,
    ...(search.get("image") === "1" ? { image: true as const } : {})
  }
}

export function PicturePage() {
  const { history } = useRouter()
  // Parsed locations reserialize search values. The tab's history keeps the original spelling.
  const search = useSyncExternalStore(history.subscribe, (): string => history.location.search)
  const portrait = pictureOf(new URLSearchParams(search))
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
