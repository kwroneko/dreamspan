// Parallel threads in one chat (spec/THREADS.md; DESIGN §3.3 [D]). A thread is a fork; a split
// records which forks run alongside each other from a message S, so they read as threads, never
// as alternate branches. What a fork is in is derived (§4.3) and carried with it.
import { Schema } from "effect"
import { EntityId, ForkId, SlotId } from "./chat.ts"

export { ThreadPlace } from "./chat.ts"

/** One thread of a set, as `ThreadsOf` lists it. */
const ThreadInfo = Schema.Struct({
  ordinal: Schema.Int,
  /** The fork that starts it: the branch it was started in for the first, a new fork for the others. */
  forkId: ForkId,
  /** False for the first thread: the branch the threads were started in, continuing. */
  starts: Schema.Boolean,
  /** Its name, the same in all its branches; null until named. */
  name: Schema.NullOr(Schema.String),
  /** The user named it. */
  nameUser: Schema.Boolean,
  /** Of its live forks, the one current most recently (the one a link opens); null: none is live. */
  openForkId: Schema.NullOr(ForkId),
  /** How many live forks it has: its own branches included. */
  forks: Schema.Int,
  rowVersion: Schema.Int
})

/** A set of threads started together at a message, as one fork sees it (`ThreadsOf`). */
export const ThreadSet = Schema.Struct({
  splitId: Schema.String,
  /** S: the message the threads continue from, and its position in the fork asked about (from 0). */
  slotId: SlotId,
  position: Schema.Int,
  /** The branch they were started in. */
  forkId: ForkId,
  createdAt: Schema.Number,
  /** Which of `threads` the fork asked about is in. */
  self: Schema.Int,
  threads: Schema.Array(ThreadInfo)
})
export type ThreadSet = typeof ThreadSet.Type

/** Input bounds keep a start transaction and list labels bounded. */
export const ThreadName = Schema.String.check(Schema.isMaxLength(200))

/** One thread of a "Start parallel threads" request: who is in it and who the user writes as there. */
const ThreadStart = Schema.Struct({
  /** A name, or null to leave it unnamed (the UI shows its characters' names). */
  name: Schema.NullOr(ThreadName),
  /** The cast members in it; everyone else in the cast is away in it. A narrator is in every thread. */
  cast: Schema.Array(EntityId),
  /** The card the user writes as there (the composer's speaker); null: the composer's choice as it is. */
  writesAs: Schema.NullOr(EntityId)
})
export const ThreadStarts = Schema.Array(ThreadStart).check(Schema.isMaxLength(32))

/** Why threads can't start as asked, in the user's words (fewer than two, one with nobody in it). */
export class ThreadsRefused extends Schema.TaggedError<ThreadsRefused>()("ThreadsRefused", {
  message: Schema.String
}) {}

/** Threads just started (`StartThreads`): the split, and each thread's fork, the first being the branch it was started in. */
export const StartedThreads = Schema.Struct({
  splitId: Schema.String,
  forkIds: Schema.Array(ForkId)
})
export type StartedThreads = typeof StartedThreads.Type
