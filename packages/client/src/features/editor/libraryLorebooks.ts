// The library's lorebooks and cards, as the Lorebooks tab and a preset's lorebooks read them:
// an import, a rename or a deletion (the `library` key) reads them again.
import { useAtomValue } from "@effect/atom-react"
import type { LibraryRef } from "@rp/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"

const lorebooksAtom = AppClient.query("ListLibrary", { kind: "lorebook" }, { reactivityKeys: ["library"] })
const cardsAtom = AppClient.query("ListLibrary", { kind: "card" }, { reactivityKeys: ["library"] })

/** The library's lorebooks; null while they load. */
export function useLibraryLorebooks(): ReadonlyArray<LibraryRef> | null {
  const result = useAtomValue(lorebooksAtom)
  return AsyncResult.isSuccess(result) ? result.value : null
}

/** Cards' upstream refs by entity, where a card's own lorebook is edited; null while loading. */
export function useCardRefs(): ReadonlyMap<string, LibraryRef> | null {
  const result = useAtomValue(cardsAtom)
  return AsyncResult.isSuccess(result)
    ? new Map(result.value.filter((ref) => ref.refKind === "upstream").map((ref) => [ref.entityId as string, ref]))
    : null
}
