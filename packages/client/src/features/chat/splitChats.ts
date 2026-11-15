import { useAtomValue } from "@effect/atom-react"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { SplitChats } from "@rp/shared/splitChat.ts"
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

export function useSplitChats(chatId: ChatId | null, forkId: string | null | undefined) {
  const result = useAtomValue(reads(chatId === null ? "" : JSON.stringify({ chatId, forkId: forkId ?? null })))
  return AsyncResult.isSuccess(result) ? result.value : null
}
