import { type ReactNode, useState } from "react"
import { useSession } from "../../session.ts"
import { usePlaceList, usePlaceNotice } from "../../usePlaceParam.ts"
import { PortraitProvider, type Portrait } from "../../ui/Portrait.tsx"
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
  const key = `rp.portraitWeights.${useSession().user.id}`
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, number>
    } catch {
      return {}
    }
  })
  const portraits = [...new Set(ids)].flatMap((id) => {
    const portrait =
      castPortrait(cast, id) ??
      (id === "model" || id === "you" ? { id, name: id === "model" ? "Model" : "You", mediaId: null } : null)
    const weight = weights[id]
    return portrait
      ? [{ portrait, weight: typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 1 }]
      : []
  })
  usePlaceNotice(
    ready && portraits.length < new Set(ids).size ? "A portrait is no longer available in this chat." : null
  )
  const change = (next: Stack<Portrait>) => {
    const nextIds = next.map((e) => e.portrait.id)
    if (JSON.stringify(nextIds) !== JSON.stringify(ids)) setIds(nextIds)
    const nextWeights = { ...weights, ...Object.fromEntries(next.map((e) => [e.portrait.id, e.weight])) }
    setWeights(nextWeights)
    try {
      localStorage.setItem(key, JSON.stringify(nextWeights))
    } catch {
      /* Still works in this view. */
    }
  }
  return (
    <PortraitProvider
      inline={wide}
      current={(portrait) => castPortrait(cast, portrait.id)}
      stack={portraits}
      onStackChange={change}
    >
      {children}
    </PortraitProvider>
  )
}
