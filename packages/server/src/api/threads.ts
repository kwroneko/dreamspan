// Parallel threads in one chat (@rp/shared/threadsApi.ts; spec/THREADS.md §5, TH2). `StartThreads`
// dispatches through the registered command `thread.start`, so a plugin can replace it and the
// in-app agent starts threads the same way. Every handler acts as the authenticated user;
// storage enforces ownership, so another user's ids are NotFound.
import { CurrentUser } from "@rp/shared/api.ts"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import { StaleWrite } from "@rp/shared/errors.ts"
import type { RefId } from "@rp/shared/library.ts"
import { ThreadsRefused } from "@rp/shared/threads.ts"
import { type StartThreadsInput, StartThreadsInput as StartInput, ThreadsStarted } from "@rp/shared/threadsApi.ts"
import { Effect } from "effect"
import { ChatHub } from "../chat/ChatHub.ts"
import { Commands, makeCommand, runCommand } from "../commands.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"

export const makeThreadHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const commands = yield* Commands
  const userId = Effect.map(CurrentUser, (user) => user.id)

  /** The chat's tabs read its branches, cast and summaries again. */
  const changed = (id: string, chatId: ChatId) =>
    Effect.gen(function* () {
      const chat = yield* reader.GetChat({ userId: id as never, chatId }).pipe(Effect.option)
      if (chat._tag === "Some") hub.publish(chatId, { _tag: "Chat", chat: chat.value })
      hub.publish(chatId, { _tag: "State" })
      hub.publish(chatId, { _tag: "Lcm" })
    })

  const start = (input: StartThreadsInput) =>
    Effect.gen(function* () {
      const id = yield* userId
      const result = yield* writer.StartThreads({ userId: id, ...input })
      hub.publish(input.chatId, { _tag: "Chat", chat: result.chat })
      hub.publish(input.chatId, { _tag: "State" })
      hub.publish(input.chatId, { _tag: "Lcm" })
      return result
    }).pipe(Effect.uninterruptible, internal("StartThreads"))

  yield* commands.register(
    makeCommand({
      id: "thread.start",
      description:
        "Start parallel threads at a message of a branch: the branch goes on as the first thread, each other thread gets a branch of its own from that message, with the characters in it; everyone else is away there.",
      input: StartInput,
      output: ThreadsStarted,
      execute: start
    })
  )

  return {
    StartThreads: (payload: StartThreadsInput) =>
      runCommand(commands, "thread.start", payload, ThreadsStarted, [StaleWrite, ThreadsRefused]),
    ThreadsOf: (payload: { chatId: ChatId; forkId: ForkId }) =>
      Effect.flatMap(userId, (id) => reader.ThreadsOf({ userId: id, ...payload })).pipe(internal("ThreadsOf")),
    RenameThread: (payload: { chatId: ChatId; splitId: string; ordinal: number; name: string; rowVersion: number }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const version = yield* writer.RenameThread({ userId: id, ...payload })
        yield* changed(id, payload.chatId)
        return version
      }).pipe(Effect.uninterruptible, internal("RenameThread")),
    UndoThreads: (payload: { chatId: ChatId; splitId: string }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const item = yield* writer.UndoThreads({ userId: id, ...payload })
        // The threads' branches are gone and the branch's marks are lifted: tabs read again.
        hub.publish(payload.chatId, { _tag: "Reload" })
        yield* changed(id, payload.chatId)
        return item
      }).pipe(Effect.uninterruptible, internal("UndoThreads")),
    CopyNoteToBranch: (payload: { chatId: ChatId; noteRefId: RefId; fromForkId: ForkId; toForkId: ForkId }) =>
      Effect.gen(function* () {
        const id = yield* userId
        const copied = yield* writer.CopyNoteToBranch({ userId: id, ...payload })
        // The other branch's tabs read their notes and state again.
        if (copied) hub.publish(payload.chatId, { _tag: "State" })
        return copied
      }).pipe(Effect.uninterruptible, internal("CopyNoteToBranch"))
  }
})
