// Parallel threads in the app (spec/THREADS.md §5, §13; DESIGN §3.3 [D]): start threads at a
// message, list the threads a branch is in, name one, and undo starting them. A group of its
// own, merged into AppApi like the merges' and the contexts'.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { BinItem } from "./bin.ts"
import { Chat, ChatId, EntityId, ForkId, MessageImages, PathEntry, QueuedMessage, SlotId } from "./chat.ts"
import { GenerationUnavailable } from "./chatApi.ts"
import { ComposerImageIds } from "./composerApi.ts"
import { Draft } from "./drafts.ts"
import { LeafMoved, NotFound, ServerError, StaleWrite } from "./errors.ts"
import { HistoryRejected } from "./historyApi.ts"
import { RefId } from "./library.ts"
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

/**
 * One thread a message goes to (spec/THREADS.md §6.2): its fork, who the user writes as there,
 * and its reply as that thread's Next decides it (Auto, a pick, No one), planned by the tab.
 */
export const SendTarget = Schema.Struct({
  forkId: ForkId,
  /** The fork's tip as the tab read it. The first target's must still be its tip (LeafMoved); the others' copies go under their tip now. */
  parentSlotId: Schema.NullOr(SlotId),
  speakerEntityId: Schema.NullOr(EntityId),
  /** False: the copy gets no reply there (Next is No one). */
  reply: Schema.Boolean,
  /** Who replies; null with `reply`: an unnamed reply. */
  replySpeakerEntityId: Schema.NullOr(EntityId),
  /** Who replies after them, in turn (DESIGN §2.3). */
  round: Schema.optionalKey(Schema.Array(EntityId).check(Schema.isMaxLength(64))),
  /** The reply's speaker and the round are Auto's picks, which the decision model may change. */
  autoPick: Schema.optionalKey(Schema.Boolean)
})
export type SendTarget = typeof SendTarget.Type

/** "To 2 threads": the thread the user is in first, then each other thread ticked. */
export const SendToThreadsInput = Schema.Struct({
  chatId: ChatId,
  content: Schema.String,
  images: Schema.optionalKey(MessageImages),
  imageDraftIds: Schema.optionalKey(ComposerImageIds),
  /** The first thread's composer draft the text came from, committed with the send. */
  composer: Schema.optionalKey(Schema.Struct({ draftId: Schema.String, session: Schema.Int })),
  targets: Schema.Array(SendTarget).check(Schema.isMinLength(2), Schema.isMaxLength(32))
})
export type SendToThreadsInput = typeof SendToThreadsInput.Type

/** One thread's copy: posted (with its reply, when one was asked for), or queued behind a reply still being written there. */
export const ThreadCopy = Schema.Union([
  Schema.TaggedStruct("Posted", { forkId: ForkId, entry: PathEntry, reply: Schema.NullOr(PathEntry) }),
  Schema.TaggedStruct("Queued", { forkId: ForkId, queued: QueuedMessage })
])
export type ThreadCopy = typeof ThreadCopy.Type

/** What a send to several threads did, in the targets' order, and the chat and its queue as they are now. */
export const SentToThreads = Schema.Struct({
  groupId: Schema.String,
  copies: Schema.Array(ThreadCopy),
  chat: Chat,
  queue: Schema.Array(QueuedMessage),
  draft: Schema.NullOr(Draft),
  recovered: Schema.Int
})
export type SentToThreads = typeof SentToThreads.Type

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
  }),
  /**
   * "Also change it in …": this chat's own note as branch `fromForkId` has it now, in branch
   * `toForkId` from its newest message on; false when it's the same there already.
   */
  Rpc.make("CopyNoteToBranch", {
    payload: { chatId: ChatId, noteRefId: RefId, fromForkId: ForkId, toForkId: ForkId },
    success: Schema.Boolean,
    error: Schema.Union([NotFound, ServerError])
  }),
  /**
   * Sends one message to several threads (registered command `thread.send`; spec/THREADS.md §6):
   * a copy appended in each target's fork, posted or queued behind a reply still being written
   * there, all in one group; each copy's reply is generated in its own thread, from that
   * thread's path alone, through the chat's connection there.
   */
  Rpc.make("SendToThreads", {
    payload: SendToThreadsInput,
    success: SentToThreads,
    error: Schema.Union([NotFound, LeafMoved, ThreadsRefused, GenerationUnavailable, HistoryRejected, ServerError])
  })
) {}
