// Parallel threads in the app (spec/THREADS.md §5, §13; DESIGN §3.3 [D]): start threads at a
// message, list the threads a branch is in, name one, and undo starting them. A group of its
// own, merged into AppApi like the merges' and the contexts'.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem } from "./bin.ts"
import { Chat, ChatId, ForkId, SlotId } from "./chat.ts"
import { NotFound, ServerError, StaleWrite } from "./errors.ts"
import { HistoryRejected } from "./historyApi.ts"
import { StartedThreads, ThreadName, ThreadSet, ThreadStarts, ThreadsRefused } from "./threads.ts"

/** "Start parallel threads" at message `slotId` of branch `forkId`, as the tab saw it (`expectedRowVersion`). */
export const StartThreadsInput = Schema.Struct({
  chatId: ChatId,
  forkId: ForkId,
  slotId: SlotId,
  expectedRowVersion: Schema.Int,
  /** The first is the branch the user is in, continuing; at least two. */
  threads: ThreadStarts
})
export type StartThreadsInput = typeof StartThreadsInput.Type

/** What starting threads made, and the chat as it is now. */
export const ThreadsStarted = Schema.Struct({ ...StartedThreads.fields, chat: Chat })
export type ThreadsStarted = typeof ThreadsStarted.Type

export class ChatThreadsApi extends RpcGroup.make(
  /**
   * Starts threads (registered command `thread.start`): the branch continues as the first, each
   * other gets a branch of its own from the message, with its characters and its composer.
   */
  Rpc.make("StartThreads", {
    payload: StartThreadsInput,
    success: ThreadsStarted,
    error: Schema.Union([NotFound, StaleWrite, ThreadsRefused, HistoryRejected, ServerError])
  }),
  /** The thread sets branch `forkId` is in, innermost first, with each thread's name and link. */
  Rpc.make("ThreadsOf", {
    payload: { chatId: ChatId, forkId: ForkId },
    success: Schema.Array(ThreadSet),
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Names a thread in all its branches (empty: unnamed); its new row version. */
  Rpc.make("RenameThread", {
    payload: {
      chatId: ChatId,
      splitId: Schema.String,
      ordinal: Schema.Int,
      name: ThreadName,
      rowVersion: Schema.Int
    },
    success: Schema.Int,
    error: Schema.Union([NotFound, StaleWrite, ServerError])
  }),
  /** Undo of starting threads: the new threads go to the bin together, and the branch is as before. */
  Rpc.make("UndoThreads", {
    payload: { chatId: ChatId, splitId: Schema.String },
    success: BinItem,
    error: Schema.Union([NotFound, ServerError])
  })
) {}
