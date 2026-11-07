import { type ReactNode, useEffect, useState } from "react"
import { Effect } from "effect"
import { galleryPortraits, galleryRef } from "../gallery/portraits.ts"
import { useCaller } from "../editor/caller.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import { useSession } from "../../session.ts"
import { usePlaceList, usePlaceNotice } from "../../usePlaceParam.ts"
import { PortraitProvider, type Portrait } from "../../ui/Portrait.tsx"
import { useWorkbenchTab } from "../workbench/tab.tsx"
import { pictureHref } from "./PicturePage.tsx"
import type { Stack } from "../../ui/portraitStack.ts"
import { castPortrait, type CastView } from "./cast.ts"

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
  const legacyKey = `rp.portraitWeights.${useSession().user.id}`
  // Duplicate views can show the same portrait at different heights. Keep each view's
  // weights with this browser tab's layout, rather than overwriting another view's values.
  const key = tab ? `${legacyKey}.${tab.tabId}` : legacyKey
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    try {
      const storage = tab ? sessionStorage : localStorage
      return JSON.parse(storage.getItem(key) ?? localStorage.getItem(legacyKey) ?? "{}") as Record<string, number>
    } catch {
      return {}
    }
  })
  const portraits = [...new Set(ids)].flatMap((id) => {
    const portrait =
      gallery[id] ??
      castPortrait(cast, id) ??
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
    const nextWeights = { ...weights, ...Object.fromEntries(next.map((e) => [e.portrait.id, e.weight])) }
    setWeights(nextWeights)
    try {
      const storage = tab ? sessionStorage : localStorage
      storage.setItem(key, JSON.stringify(nextWeights))
    } catch {
      /* Still works in this view. */
    }
  }
  return (
    <PortraitProvider
      inline={wide}
      current={(portrait) => gallery[portrait.id] ?? castPortrait(cast, portrait.id)}
      stack={portraits}
      onStackChange={change}
      tabHref={tab ? pictureHref : undefined}
    >
      {children}
    </PortraitProvider>
  )
}
