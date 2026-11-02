// The Cast tab and each character tab read the same live definitions at the viewed tip.
import { useAtomValue } from "@effect/atom-react"
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { ChatCard } from "@rp/shared/chatSetupApi.ts"
import { AsyncResult, Atom } from "effect/reactivity"
import { useSyncExternalStore } from "react"
import { AppClient } from "../../rpc.ts"
import type { ChatSession } from "./session.ts"

const empty = Atom.make(AsyncResult.success<ReadonlyArray<ChatCard>>([]))
const queries = Atom.family((key: string) => {
  const [chatId, forkId, slotId, entityIds] = JSON.parse(key) as [ChatId, ForkId | null, SlotId | null, EntityId[]]
  return entityIds.length === 0
    ? empty
    : AppClient.query(
        "ListChatCards",
        { chatId, forkId, slotId, entityIds },
        { reactivityKeys: ["library", `chat-cards:${chatId}`] }
      )
})

export function useChatCards(session: ChatSession) {
  const key = useSyncExternalStore(session.subscribe, () => {
    const { cast, forkId, leafSlotId } = session.snapshot()
    const entityIds =
      cast?.cards
        .filter(
          (card) =>
            !card.inBin && (cast.participants.includes(card.entityId) || cast.playedByMe.includes(card.entityId))
        )
        .map((card) => card.entityId)
        .sort() ?? []
    return JSON.stringify([session.id, forkId, leafSlotId, entityIds])
  })
  return useAtomValue(queries(key))
}
