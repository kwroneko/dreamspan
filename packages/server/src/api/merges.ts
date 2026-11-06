// Merging another chat into this one (spec/CHAT-MERGE.md §8; owner decisions DESIGN §3.3,
// 2026-11-05). `MergeChat` dispatches through the registered command `chat.merge`, so a plugin
// can replace it and the in-app agent merges the same way.
import { CurrentUser } from "@rp/shared/api.ts"
import { PathEntry } from "@rp/shared/chat.ts"
import { StaleWrite } from "@rp/shared/errors.ts"
import { MergeChanged, MergeChatInput, MergedChat, MergeRefused, type MergeRequest } from "@rp/shared/mergeApi.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Commands, makeCommand, runCommand } from "../commands.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeMergeHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const commands = yield* Commands
  const userId = Effect.map(CurrentUser, (user) => user.id)

  const merge = (input: MergeChatInput) =>
    Effect.gen(function* () {
      const id = yield* userId
      const result = yield* writer.MergeChat({ userId: id, ...input })
      // The fork's tabs place the join by its position, as an inserted message's.
      const { entry } = yield* reader.GetSlot({ userId: id, slotId: result.slotId, forkId: result.forkId })
      const placed = new PathEntry({ ...entry, position: result.position })
      hub.publish(input.chatId, { _tag: "Slot", entry: placed })
      hub.publish(input.chatId, { _tag: "Chat", chat: result.chat })
      // The cast gained the source's members; a summary covering the position is stale now.
      hub.publish(input.chatId, { _tag: "State" })
      hub.publish(input.chatId, { _tag: "Lcm" })
      return new MergedChat({ entry: placed, chat: result.chat })
    }).pipe(Effect.uninterruptible, internal("MergeChat"))

  yield* commands.register(
    makeCommand({
      id: "chat.merge",
      description:
        "Merge another chat or branch into this chat's branch, below a message: its messages since the part both share come in as one join message, and its cast joins.",
      input: MergeChatInput,
      output: MergedChat,
      execute: merge
    })
  )

  return {
    PreviewChatMerge: (payload: MergeRequest) =>
      Effect.flatMap(userId, (id) => reader.PreviewChatMerge({ userId: id, ...payload })).pipe(
        internal("PreviewChatMerge")
      ),
    MergeChat: (payload: MergeChatInput) =>
      runCommand(commands, "chat.merge", payload, MergedChat, [StaleWrite, MergeRefused, MergeChanged]),
    GetMerge: (payload: { chatId: MergeRequest["chatId"]; slotId: MergeRequest["at"] & string }) =>
      Effect.flatMap(userId, (id) => reader.GetMerge({ userId: id, ...payload })).pipe(internal("GetMerge")),
    MergeMessages: (payload: { chatId: MergeRequest["chatId"]; mergeId: string; offset: number; limit: number }) =>
      Effect.flatMap(userId, (id) => reader.MergeMessages({ userId: id, ...payload })).pipe(internal("MergeMessages"))
  }
})
