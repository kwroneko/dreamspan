import { type ReactNode, useEffect, useId, useState } from "react"
import { Effect } from "effect"
import { galleryPortraits, galleryRef } from "../gallery/portraits.ts"
import { useCaller } from "../editor/caller.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import { usePlaceList, usePlaceNotice, usePlaceValue } from "../../usePlaceParam.ts"
import { PortraitProvider, type Portrait } from "../../ui/Portrait.tsx"
import { useWorkbenchTab } from "../workbench/tab.tsx"
import { pictureHref } from "./PicturePage.tsx"
import type { Stack } from "../../ui/portraitStack.ts"
import { castPortrait, type CastView } from "./cast.ts"
import { attachmentOf } from "./attachmentPictures.ts"
import { whenDragEnds } from "../../tabLayoutParams.ts"

/** A share's bounds: a crafted URL can't make the stack's sum overflow or a viewer vanish. */
const MIN_WEIGHT = 0.05
const MAX_WEIGHT = 20
/** At most this many portraits' shares go in the URL and are read back: the first ones shown. */
export const MAX_WEIGHTS = 12

/** A share as the URL keeps it: rounded, within the bounds. Written and read alike. */
const shareOf = (w: number) => Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.round(w * 1000) / 1000))

/** The URL's shares, each a number clamped to the bounds. */
export const decodeWeights = (raw: unknown): Record<string, number> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw)
          .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] > 0)
          .slice(0, MAX_WEIGHTS)
          .map(([id, w]) => [id, shareOf(w)])
      )
    : {}

/** The shares the URL keeps for the shown portraits (in order): what `decodeWeights` reads back. */
export const keptWeights = (shown: ReadonlyArray<readonly [string, number]>): Record<string, number> =>
  Object.fromEntries(shown.slice(0, MAX_WEIGHTS).map(([id, w]) => [id, shareOf(w)]))

export function ChatPortraitProvider({
  wide,
  cast,
  ready,
  children
}: {
  wide: boolean
  cast: CastView
  ready: boolean
  children: ReactNode
}) {
  const [ids, setIds] = usePlaceList("portraits")
  const tab = useWorkbenchTab()
  const call = useCaller()
  const [gallery, setGallery] = useState<Record<string, Portrait>>({})
  const [galleryReady, setGalleryReady] = useState(false)
  const refs = [...new Set(ids.flatMap((id) => galleryRef(id) ?? []))].sort().join(",")
  useEffect(() => {
    let live = true
    const refresh = async () => {
      const result = await call((client) =>
        Effect.forEach(refs ? refs.split(",") : [], (refId) =>
          client("GetCardGallery", { refId: refId as import("@rp/shared/library.ts").RefId }).pipe(
            Effect.map((value) => galleryPortraits(refId, value)),
            Effect.orElseSucceed(() => [])
          )
        )
      )
      if (live && result.ok) {
        setGallery(Object.fromEntries(result.value.flat().map((p) => [p.id, p])))
        setGalleryReady(true)
      }
    }
    void refresh()
    const off = onLibraryChange(() => void refresh())
    return () => {
      live = false
      off()
    }
  }, [call, refs, cast])
  // The stacked portraits' shares of the column: in the view's URL beside its pictures
  // (`portraitSizes`, each workbench tab its own), written once a drag of a boundary ends;
  // meanwhile the drag's shares show from `dragging`.
  const [savedWeights, setSavedWeights] = usePlaceValue("portraitSizes")
  const writeKey = useId()
  const [dragging, setDragging] = useState<Record<string, number> | null>(null)
  const weights = dragging ?? decodeWeights(savedWeights)
  const portraits = [...new Set(ids)].flatMap((id) => {
    const portrait =
      gallery[id] ??
      castPortrait(cast, id) ??
      attachmentOf(id) ??
      (id === "model" || id === "you" ? { id, name: id === "model" ? "Model" : "You", mediaId: null } : null)
    const weight = weights[id]
    return portrait
      ? [{ portrait, weight: typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 1 }]
      : []
  })
  usePlaceNotice(
    ready && galleryReady && portraits.length < new Set(ids).size
      ? "A portrait is no longer available in this chat."
      : null
  )
  const change = (next: Stack<Portrait>) => {
    setGallery((all) => ({
      ...all,
      ...Object.fromEntries(next.filter((e) => galleryRef(e.portrait.id)).map((e) => [e.portrait.id, e.portrait]))
    }))
    const nextIds = next.map((e) => e.portrait.id)
    if (JSON.stringify(nextIds) !== JSON.stringify(ids)) setIds(nextIds)
    // Only the portraits shown, rounded: the default share (1 each) leaves the URL. Not merely
    // equal shares: the column stacks every workbench frame's portraits, so a frame's lone
    // portrait at 0.9 is a share against another frame's, and must stay.
    const nextWeights = Object.fromEntries(next.map((e) => [e.portrait.id, Math.round(e.weight * 1000) / 1000]))
    // What reading the URL gives back, so a reload shows what the drag left.
    const kept = keptWeights(next.map((e) => [e.portrait.id, e.weight] as const))
    const even = Object.values(kept).every((w) => w === 1)
    setDragging(nextWeights)
    // Keyed by this provider: one drag changes every frame's share, and each frame writes its own.
    whenDragEnds(`portraitSizes:${writeKey}`, () => {
      setSavedWeights(() => (even ? undefined : kept))
      setDragging(null)
    })
  }
  return (
    <PortraitProvider
      inline={wide}
      current={(portrait) => gallery[portrait.id] ?? castPortrait(cast, portrait.id) ?? attachmentOf(portrait.id)}
      stack={portraits}
      onStackChange={change}
      tabHref={tab ? pictureHref : undefined}
    >
      {children}
    </PortraitProvider>
  )
}
