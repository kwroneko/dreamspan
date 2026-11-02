import { libraryListAtom } from "../library/queries.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { cardNameClash } from "@rp/shared/cardNames.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { useEffect } from "react"
import { onLibraryChange } from "../../libraryChanges.ts"
import { AsyncResult } from "effect/reactivity"
import { allOf } from "../../actions.tsx"

const cards = allOf({
  live: libraryListAtom("card"),
  archived: libraryListAtom("card", true)
})

export function useCardNameCheck(name: string, version: string, current?: LibraryRef) {
  const result = useAtomValue(cards)
  const refresh = useAtomRefresh(cards)
  useEffect(() => onLibraryChange(refresh), [refresh])
  if (!AsyncResult.isSuccess(result))
    return AsyncResult.isFailure(result)
      ? "Card names could not be checked. Try reopening this page."
      : "Checking card names…"
  return cardNameClash([...result.value.live, ...result.value.archived], name, version, current)
}
