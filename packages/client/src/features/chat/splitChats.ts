import { useAtomValue } from "@effect/atom-react"
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import type { SplitChats } from "@dreamspan/shared/splitChat.ts"
import { AsyncResult, Atom } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"

const reads = Atom.family((key: string) =>
  key === ""
    ? Atom.make(AsyncResult.initial<SplitChats>())
    : AppClient.query("GetSplitChats", JSON.parse(key) as { chatId: ChatId; forkId: ForkId | null }, {
        reactivityKeys: ["chats", "chat-lists", "pins", "library"],
        timeToLive: "2 minutes"
      })
)

/** The own picture of the chat shown (the group the viewed branch is in), a media id; null: none. */
export function useChatPicture(view: {
  readonly chat: { readonly id: ChatId } | null
  readonly forkId: string | null
}) {
  return useSplitChats(view.chat?.id ?? null, view.forkId)?.group.picture ?? null
}

const keyOf = (chatId: ChatId | null, forkId: string | null | undefined) =>
  chatId === null ? "" : JSON.stringify({ chatId, forkId: forkId ?? null })

/**
 * Answers read before the page that shows them opens (a new chat's first send reads its
 * own), used until the shared read answers so the header never waits on it.
 */
const seeds = new Map<string, SplitChats>()
export const seedSplitChats = (chatId: ChatId, forkId: ForkId | null, value: SplitChats) => {
  seeds.set(keyOf(chatId, forkId), value)
}

export function useSplitChats(chatId: ChatId | null, forkId: string | null | undefined) {
  const key = keyOf(chatId, forkId)
  const result = useAtomValue(reads(key))
  if (AsyncResult.isSuccess(result)) {
    seeds.delete(key)
    return result.value
  }
  return seeds.get(key) ?? null
}
