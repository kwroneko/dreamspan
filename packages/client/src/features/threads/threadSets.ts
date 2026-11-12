// The thread sets a branch is in (spec/THREADS.md §13; `ThreadsOf`), shared by every surface
// that shows them: the header's control, its Threads section, the timeline's row and the note
// editor's offer. One read per fork and version, however many surfaces ask: the version is the
// chat's row version (a split, a rename and an Undo bump it, here or in another tab) and the
// branch lists' count (`forksChanged`). The registered transforms and the branch control read
// it synchronously and hear when a read lands (`timelineInputsChanged`, `branchPartsChanged`).
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { ThreadSet } from "@rp/shared/threads.ts"
import { useEffect, useSyncExternalStore } from "react"
import { branchPartsChanged } from "../chat/branchParts.ts"
import { useForksVersion } from "../chat/forks.ts"
import type { ChatSession, ChatView } from "../chat/session.ts"
import { timelineInputsChanged } from "../chat/timelineContributions.tsx"

type Sets = ReadonlyArray<ThreadSet>

/** Reads by `${chatId}/${forkId}/${version}`; null while one is on its way. */
const reads = new Map<string, Sets | null>()
/** The last answer for each `${chatId}/${forkId}`, shown while a newer read is on its way. */
const latest = new Map<string, { readonly key: string; readonly sets: Sets }>()
const listeners = new Set<() => void>()
let revision = 0
export const subscribeThreadSets = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const changed = () => {
  revision++
  for (const listener of listeners) listener()
  timelineInputsChanged()
  branchPartsChanged()
}

const keyOf = (chatId: ChatId, forkId: ForkId, version: string) => `${chatId}/${forkId}/${version}`

/** Reads fork `forkId`'s sets at `version` unless that read was made or is on its way. */
export const loadThreadSets = (session: ChatSession, chatId: ChatId, forkId: ForkId, version: string) => {
  const key = keyOf(chatId, forkId, version)
  if (reads.has(key)) return
  reads.set(key, null)
  void session
    .call((client) => client("ThreadsOf", { chatId, forkId }))
    .then((result) => {
      // A fork that's gone (an Undo) is in no set.
      const sets = result.ok ? result.value : []
      reads.set(key, sets)
      const fork = `${chatId}/${forkId}`
      const previous = latest.get(fork)
      if (previous && previous.key !== key) reads.delete(previous.key)
      latest.set(fork, { key, sets })
      changed()
    })
}

/** What's known now of fork `forkId`'s sets: this version's, else the last read's; null before any. */
export const threadSetsNow = (chatId: ChatId, forkId: ForkId, version?: string): Sets | null =>
  (version === undefined ? undefined : reads.get(keyOf(chatId, forkId, version))) ??
  latest.get(`${chatId}/${forkId}`)?.sets ??
  null

/** The fork a view shows. */
export const shownForkOf = (view: ChatView): ForkId | null => view.forkId ?? view.chat?.currentForkId ?? null

/** The version reads of this chat's sets are made at. */
export const useThreadsVersion = (session: ChatSession, view: ChatView) => {
  const bump = useForksVersion(session.id)
  return `${view.chat?.rowVersion ?? 0}/${bump}`
}

/** Sets of each of `forkIds`, read as needed: null for one not read yet. */
export function useThreadSetsOf(
  session: ChatSession,
  chatId: ChatId | null,
  forkIds: ReadonlyArray<ForkId>,
  version: string
): ReadonlyMap<ForkId, Sets | null> {
  useSyncExternalStore(subscribeThreadSets, () => revision)
  const wanted = forkIds.join(",")
  useEffect(() => {
    if (chatId === null) return
    for (const forkId of forkIds) loadThreadSets(session, chatId, forkId, version)
    // `wanted` stands for `forkIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, chatId, wanted, version])
  return new Map(forkIds.map((forkId) => [forkId, chatId === null ? null : threadSetsNow(chatId, forkId, version)]))
}

/** The sets the fork a view shows is in, innermost first: [] in none, null before the first read. */
export function useThreadSets(session: ChatSession, view: ChatView): Sets | null {
  const version = useThreadsVersion(session, view)
  const forkId = shownForkOf(view)
  const chatId = view.chat?.id ?? null
  return useThreadSetsOf(session, chatId, forkId === null ? [] : [forkId], version).get(forkId!) ?? null
}

/** For tests: forget every read. */
export const resetThreadSets = () => {
  reads.clear()
  latest.clear()
  changed()
}
