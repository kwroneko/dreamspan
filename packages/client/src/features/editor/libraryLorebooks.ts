import { AppClient } from "../../rpc.ts"
import { libraryListAtom } from "../library/queries.ts"
// The library's lorebooks and cards, as the Lorebooks tab and a preset's lorebooks read them:
// an import, a rename or a deletion (the `library` key) reads them again. The lorebooks stay five
// minutes after the last tab reading them goes, shown at once in the next chat and read again behind.
import { useAtomValue } from "@effect/atom-react"
import { useAtomRevalidated } from "../../actions.tsx"
import type { LibraryRef } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"

const lorebooksAtom = libraryListAtom("lorebook")
const filterCardsAtom = AppClient.query(
  "ListLibrary",
  { kind: "card", withFilterData: true },
  { reactivityKeys: ["library"] }
)
const cardsAtom = libraryListAtom("card")

/** The library's lorebooks; null while they load. */
export function useLibraryLorebooks(): ReadonlyArray<LibraryRef> | null {
  const result = useAtomRevalidated(lorebooksAtom)
  return AsyncResult.isSuccess(result) ? result.value : null
}

/** Cards' upstream refs by entity, where a card's own lorebook is edited; null while loading. */
export function useCardRefs(): ReadonlyMap<string, LibraryRef> | null {
  const result = useAtomValue(cardsAtom)
  return AsyncResult.isSuccess(result) ? new Map(result.value.map((ref) => [ref.entityId as string, ref])) : null
}

export function useLoreFilterCards(): ReadonlyArray<LibraryRef> {
  const result = useAtomRevalidated(filterCardsAtom)
  return AsyncResult.isSuccess(result) ? result.value : []
}
