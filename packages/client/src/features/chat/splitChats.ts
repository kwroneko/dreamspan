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

export function useSplitChats(chatId: ChatId | null, forkId: string | null | undefined) {
  const result = useAtomValue(reads(chatId === null ? "" : JSON.stringify({ chatId, forkId: forkId ?? null })))
  return AsyncResult.isSuccess(result) ? result.value : null
}
