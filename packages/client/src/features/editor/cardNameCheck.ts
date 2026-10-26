import { useAtomValue } from "@effect/atom-react"
import { cardNameClash } from "@rp/shared/cardNames.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"
import { allOf } from "../../actions.tsx"

const cards = allOf({
  live: AppClient.query("ListLibrary", { kind: "card" }, { reactivityKeys: ["library"] }),
  archived: AppClient.query("ListLibrary", { kind: "card", archived: true }, { reactivityKeys: ["library"] })
})

export function useCardNameCheck(name: string, version: string, current?: LibraryRef) {
  const result = useAtomValue(cards)
  if (!AsyncResult.isSuccess(result))
    return AsyncResult.isFailure(result)
      ? "Card names could not be checked. Try reopening this page."
      : "Checking card names…"
  return cardNameClash([...result.value.live, ...result.value.archived], name, version, current)
}
