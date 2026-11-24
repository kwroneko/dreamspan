// Parallel threads in one chat (@dreamspan/shared/threadsApi.ts; spec/THREADS.md §5, TH2). `StartThreads`
// dispatches through the registered command `thread.start`, so a plugin can replace it and the
// in-app agent starts threads the same way. Every handler acts as the authenticated user;
// storage enforces ownership, so another user's ids are NotFound.
import { BinItem } from "@dreamspan/shared/bin.ts"
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { ChatId, ForkId, PathEntry } from "@dreamspan/shared/chat.ts"
import { GenerationUnavailable } from "@dreamspan/shared/chatApi.ts"
import { LeafMoved, StaleWrite } from "@dreamspan/shared/errors.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { ThreadsRefused } from "@dreamspan/shared/threads.ts"
import {
  type SendToThreadsInput,
  SendToThreadsInput as SendInput,
  SentToThreads,
  type StartThreadsInput,
  StartThreadsInput as StartInput,
  type ThreadCopy,
  ThreadsStarted
} from "@dreamspan/shared/threadsApi.ts"
import { Effect, Option } from "effect"
import { CacheWarmth } from "../chat/CacheWarmth.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Generations } from "../chat/Generations.ts"
import { Generator } from "../chat/Generator.ts"
import { rewriteText } from "../chat/rewrites.ts"
import { Commands, makeCommand, runCommand } from "../commands.ts"
import { Reader, Writer } from "../db/Database.ts"
import { notifyWorkshopDeletions } from "./bin.ts"
import { internal } from "./internal.ts"

export const makeThreadHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const hub = yield* ChatHub
  const commands = yield* Commands
  const generations = yield* Generations
  const generator = yield* Generator
  const warmth = yield* CacheWarmth
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
      const { continuingChoice, ...result } = yield* writer.StartThreads({ userId: id, ...input })
      if (continuingChoice) hub.publish(input.chatId, { _tag: "ComposerChoice", choice: continuingChoice })
      hub.publish(input.chatId, { _tag: "Chat", chat: result.chat })
      hub.publish(input.chatId, { _tag: "State" })
      hub.publish(input.chatId, { _tag: "Lcm" })
      return result
    }).pipe(Effect.uninterruptible, internal("StartThreads"))

  /**
   * One message to several threads (spec/THREADS.md §6.2): each copy through its own thread's
   * scripts, written together, then each reply's generation started in its own fork, which
   * assembles from that thread's path alone and sends through the chat's connection there.
   */
  const send = (input: SendToThreadsInput) =>
    Effect.gen(function* () {
      const id = yield* userId
      if (Option.isNone(generator) && input.targets.some((target) => target.reply))
        return yield* new GenerationUnavailable({ message: "This server has nothing to generate with." })
      const targets = yield* Effect.forEach(input.targets, (target) =>
        Effect.gen(function* () {
          const written = yield* rewriteText(reader, {
            userId: id,
            chatId: input.chatId,
            forkId: target.forkId,
            at: { leafSlotId: target.parentSlotId, speakerEntityId: target.speakerEntityId },
            edit: false,
            content: input.content
          })
          return { ...target, content: written.content, ...(written.rewrite ? { rewrite: written.rewrite } : {}) }
        })
      )
      const result = yield* writer.SendToThreads({
        userId: id,
        chatId: input.chatId,
        ...(input.images === undefined ? {} : { images: input.images }),
        ...(input.imageDraftIds === undefined ? {} : { imageDraftIds: input.imageDraftIds }),
        commitDraft: input.composer === undefined ? null : input.composer,
        targets
      })
      const entryOf = (slotId: PathEntry["slotId"], forkId: ForkId) =>
        Effect.map(reader.GetSlot({ userId: id, slotId, forkId }), ({ entry }) => {
          hub.publish(input.chatId, { _tag: "Slot", entry })
          return entry
        })
      const copies: Array<ThreadCopy> = []
      for (const copy of result.copies) {
        if (copy._tag === "Queued") {
          copies.push(copy)
          continue
        }
        if (copy.reply !== null)
          yield* generations.start({
            userId: id,
            chatId: input.chatId,
            slotId: copy.reply.slotId,
            versionId: copy.reply.versionId,
            forkId: copy.forkId
          })
        copies.push({
          _tag: "Posted",
          forkId: copy.forkId,
          entry: yield* entryOf(copy.slotId, copy.forkId),
          reply: copy.reply === null ? null : yield* entryOf(copy.reply.slotId, copy.forkId)
        })
      }
      if (input.targets.some((target) => target.reply)) warmth.expectReply(input.chatId)
      hub.publish(input.chatId, { _tag: "Chat", chat: result.chat })
      hub.publish(input.chatId, { _tag: "Queue", queue: result.queue })
      return {
        groupId: result.groupId,
        copies,
        chat: result.chat,
        queue: result.queue,
        draft: result.draft,
        recovered: result.recovered
      }
    }).pipe(Effect.uninterruptible, internal("SendToThreads"))

  yield* commands.register(
    makeCommand({
      id: "thread.send",
      description:
        "Send one message to several threads of a chat: a copy in each, as the card given for it there, each followed by the reply its thread's Next asks for, generated from that thread alone.",
      input: SendInput,
      output: SentToThreads,
      execute: send
    })
  )

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
    SendToThreads: (payload: SendToThreadsInput) =>
      runCommand(commands, "thread.send", payload, SentToThreads, [LeafMoved, ThreadsRefused, GenerationUnavailable]),
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
        // The workshops beside the threads that went with them: their tabs are told.
        yield* notifyWorkshopDeletions(id, item.workshops)
        // The threads' branches are gone and the branch's marks are lifted: tabs read again.
        hub.publish(payload.chatId, { _tag: "Reload" })
        yield* changed(id, payload.chatId)
        return new BinItem(item)
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
