// Inspect the production navigation handlers on their own read-only connection.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { readerConnection } from "../../src/db/connection.ts"
import { makeShellReadHandlers } from "../../src/db/shellReads.ts"
import { makeThreadReadHandlers } from "../../src/db/threadReads.ts"
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"

const { file, userId, otherUserId, chatId, forkId } = workerData as {
  file: string
  userId: UserId
  otherUserId: UserId
  chatId: ChatId
  forkId: ForkId
}
const queries: string[] = []
let capture = false
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (text) {
  if (capture) queries.push(text)
  return prepare.call(this, text)
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const shell = yield* makeShellReadHandlers
    const threads = yield* makeThreadReadHandlers
    capture = true
    const actual = yield* shell.GetSplitChats({ userId, chatId, forkId })
    const ownThreads = yield* threads.ThreadsOf({ userId, chatId, forkId })
    capture = false
    const full = yield* shell.ShellLibrary({ userId, recompute: true })
    const rows = full.forks.filter((row) => row.sourceChatId === chatId)
    const current = rows.find((row) => row.current)!
    const expected = {
      group: {
        id: chatId,
        chatId,
        forkId: current.forkId,
        rootForkId: chatId,
        title: current.chatName,
        slotId: null,
        split: null
      },
      parent: null,
      children: [],
      forkIds: rows.map((row) => row.forkId),
      hasSplits: false,
      canSplit: forkId !== String(chatId)
    }
    const foreign = yield* Effect.flip(shell.GetSplitChats({ userId: otherUserId, chatId, forkId }))
    const foreignThread = yield* Effect.flip(threads.ThreadsOf({ userId: otherUserId, chatId, forkId }))
    return { actual, expected, ownThreads, foreign: foreign._tag, foreignThread: foreignThread._tag, queries }
  }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
)
parentPort!.postMessage(result)
