import { libraryListAtom } from "../library/queries.ts"
// What a card's actions need of its library entry (`ChatCardInfo`), in a chat not made yet:
// a saved chat reads it with `ListChatCards`, which needs the chat; before the first send it
// comes from the library's lists, each card at its latest revision.
import { useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { AsyncResult } from "effect/reactivity"
import { useCallback } from "react"
import { shellAtom } from "../characters/shellData.tsx"
import type { ChatCardInfo } from "./CardForkDialogs.tsx"

const refsAtom = libraryListAtom("card")

/** A lookup from a card to its entry: the characters' from the shell, a persona's from the library. */
export function usePendingCardInfo(): (entityId: EntityId) => ChatCardInfo | undefined {
  const shell = useAtomValue(shellAtom)
  const refs = useAtomValue(refsAtom)
  return useCallback(
    (entityId: EntityId) => {
      const card = AsyncResult.isSuccess(shell)
        ? shell.value.cards.find((item) => item.card.entityId === entityId)?.card
        : undefined
      if (card) return { entityId, refId: card.refId, usedByChats: card.chats, binding: "default" as const }
      const ref = AsyncResult.isSuccess(refs) ? refs.value.find((item) => item.entityId === entityId) : undefined
      return ref ? { entityId, refId: ref.id, usedByChats: 0, binding: "default" as const } : undefined
    },
    [shell, refs]
  )
}
