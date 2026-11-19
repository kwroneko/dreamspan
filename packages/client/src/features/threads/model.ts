// What the threads' surfaces say and decide, apart from React (spec/THREADS.md §5.1, §13):
// a thread's name, which forks the Branches list leaves out, the start dialog's rows, its
// default "Writes as", what's wrong with a request, and its line on the messages after S.
import type { EntityId, Fork, ForkId } from "@dreamspan/shared/chat.ts"
import type { ThreadInfo, ThreadSet } from "@dreamspan/shared/threads.ts"
import type { StartThreadsInput } from "@dreamspan/shared/threadsApi.ts"
import { listNames } from "../chat/cast.ts"

/** A thread as people read it: its name, else its characters' names, else "Thread 2". */
export const threadName = (
  thread: Pick<ThreadInfo, "name" | "cast" | "ordinal">,
  nameOf: (id: EntityId) => string | null
) => thread.name ?? (listNames(thread.cast.flatMap((id) => nameOf(id) ?? [])) || `Thread ${thread.ordinal + 1}`)

/** The message the threads continue from, as messages are numbered: "#40". */
export const splitNumber = (set: Pick<ThreadSet, "position">) => `#${set.position + 1}`

/** The thread of a set that the fork asked about is in. */
export const ownThread = (set: ThreadSet) => set.threads.find((thread) => thread.ordinal === set.self)

/**
 * Whether the Branches list lists a fork (§13.2): every set it's in, the fork shown is in too,
 * as the same thread. Another thread's forks, of a set the fork shown is in or one it's outside,
 * are listed as threads, never as branches.
 */
export const listedAsBranch = (fork: Pick<Fork, "threads">, shown: Pick<Fork, "threads"> | undefined) =>
  (fork.threads ?? []).every((place) =>
    (shown?.threads ?? []).some((own) => own.splitId === place.splitId && own.ordinal === place.ordinal)
  )

/** The splits forks are in that the fork shown isn't, each with a fork of it to ask `ThreadsOf`. */
export const otherSplits = (
  forks: ReadonlyArray<Pick<Fork, "id" | "threads">>,
  own: ReadonlySet<string>
): ReadonlyArray<{ readonly splitId: string; readonly forkId: ForkId }> => {
  const found = new Map<string, ForkId>()
  for (const fork of forks)
    for (const place of fork.threads ?? [])
      if (!own.has(place.splitId) && !found.has(place.splitId)) found.set(place.splitId, fork.id)
  return [...found].map(([splitId, forkId]) => ({ splitId, forkId }))
}

/** Who the start dialog can put in a thread, from the cast at the message. */
export interface StartCast {
  /** Characters the model writes, narrators left out. */
  readonly characters: ReadonlyArray<EntityId>
  /** Cast characters, including any played by the user: these receive away marks. */
  readonly members: ReadonlyArray<EntityId>
  /** The user's own cards. */
  readonly mine: ReadonlyArray<EntityId>
  /** Narrators: in every thread, never listed. */
  readonly narrators: ReadonlyArray<EntityId>
}

export const startCast = (cast: {
  readonly participants: ReadonlyArray<EntityId>
  readonly playedByMe: ReadonlyArray<EntityId>
  readonly roles?: Readonly<Record<string, "narrator">> | undefined
}): StartCast => {
  const narrators = cast.participants.filter((id) => cast.roles?.[id] === "narrator")
  return {
    narrators,
    members: cast.participants.filter((id) => !narrators.includes(id)),
    mine: cast.playedByMe.filter((id) => !narrators.includes(id)),
    characters: cast.participants.filter((id) => !narrators.includes(id) && !cast.playedByMe.includes(id))
  }
}

/** One row of the dialog. `writesAs` null: the default (as now in this branch, else `defaultWritesAs`). */
export interface DraftThread {
  readonly key: number
  readonly name: string
  readonly cast: ReadonlyArray<EntityId>
  readonly writesAs: EntityId | null
}

/** The two rows it opens with: everyone in This branch, nobody yet in the new thread. */
export const initialThreads = (cast: StartCast): ReadonlyArray<DraftThread> => [
  { key: 0, name: "", cast: [...cast.characters, ...cast.mine], writesAs: null },
  { key: 1, name: "", cast: [], writesAs: null }
]

/** A new thread's "Writes as": one of the user's cards in it, else a narrator, else its first character. */
export const defaultWritesAs = (thread: Pick<DraftThread, "cast">, cast: StartCast): EntityId | null =>
  thread.cast.find((id) => cast.mine.includes(id)) ?? cast.narrators[0] ?? thread.cast[0] ?? null

/** What's wrong with the rows, in the user's words; null when they can start. */
export const startProblem = (threads: ReadonlyArray<DraftThread>, cast: StartCast): string | null => {
  if (threads.length < 2) return "Start at least two threads."
  if (cast.narrators.length > 0) return null
  const empty = threads.findIndex((thread) => !thread.cast.some((id) => cast.members.includes(id)))
  return empty < 0 ? null : `${empty === 0 ? "This branch" : `Thread ${empty + 1}`} has no character in it.`
}

/** The request's threads: the first keeps the composer as it is unless a card was picked. */
export const startRequest = (threads: ReadonlyArray<DraftThread>, cast: StartCast): StartThreadsInput["threads"] =>
  threads.map((thread, index) => ({
    name: thread.name.trim() === "" ? null : thread.name.trim(),
    cast: thread.cast,
    writesAs: thread.writesAs ?? (index === 0 ? null : defaultWritesAs(thread, cast))
  }))

/**
 * Started at an earlier message (§5.1; owner, 2026-11-12): what happens to the messages after
 * it. `at` and `last` are positions (from 0); `last` null when the newest isn't known here.
 */
export const playedLine = (at: number, last: number | null, moved: ReadonlyArray<string>) => {
  const first = at + 2
  const span =
    last === null
      ? `The messages after #${at + 1} become`
      : last + 1 === first
        ? `#${first} becomes`
        : `#${first}–#${last + 1} become`
  const who =
    moved.length === 0
      ? "Nobody is marked away for them. Who was there stays as recorded."
      : `${listNames(moved)} ${moved.length === 1 ? "counts" : "count"} as not there for them, in this branch only. They still know their own messages.`
  return `${span} this branch’s thread. ${who}`
}
