// A chat's branches as the header lists them (DESIGN §3.2; the forks of
// spec/FORK-INDEPENDENCE-DELTA.md, which the UI calls branches): every live fork, most
// recently current first, with its name, its last message's first words and when it was last
// chatted in. Read with `ListForks` when the chat opens and again whenever what it lists may
// have changed: the fork shown, the chat's record (its current fork), a branch's name, or a
// branch made, renamed or deleted here (`forksChanged`).
import type { ChatId, Fork, PathEntry } from "@rp/shared/chat.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { positionOf } from "./position.ts"
import type { ChatSession, ChatView } from "./session.ts"

/** The name a branch made at `entry` starts with, which the user can change: "From #14". */
export const automaticBranchName = (entry: Pick<PathEntry, "position" | "depth">) => `From #${positionOf(entry) + 1}`

/**
 * A branch as people read it: its name, else "Original" for the chat's first fork, else
 * "Branch k" by when it was made among `forks`.
 */
export const branchLabel = (fork: Fork, forks: ReadonlyArray<Fork>) => {
  if (fork.name !== null && fork.name !== "") return fork.name
  if (fork.parentForkId === null) return "Original"
  const made = [...forks].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return `Branch ${made.findIndex((f) => f.id === fork.id) + 1}`
}

/** When a branch was last chatted in, else made. */
export const branchActivity = (fork: Fork) => Math.max(fork.createdAt, fork.lastChattedAt ?? 0)

// Writes made here bump a chat's count, so every list of its branches reads again at once. A
// branch made here is listed from the write's answer until a read made after it has it.
const bumps = new Map<ChatId, number>()
const made = new Map<ChatId, Array<{ readonly fork: Fork; readonly bump: number }>>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const forksChanged = (chatId: ChatId, created?: Fork) => {
  const bump = (bumps.get(chatId) ?? 0) + 1
  bumps.set(chatId, bump)
  if (created) made.set(chatId, [...(made.get(chatId) ?? []), { fork: created, bump }])
  for (const listener of listeners) listener()
}

export interface ChatForks {
  /** Null until the first read answers. */
  readonly forks: ReadonlyArray<Fork> | null
  /** The fork shown: the URL's, else the chat's current one. */
  readonly shown: Fork | undefined
  readonly reload: () => void
}

export function useChatForks(session: ChatSession, view: ChatView): ChatForks {
  const bump = useSyncExternalStore(subscribe, () => bumps.get(session.id) ?? 0)
  const [read, setRead] = useState<{ key: string; bump: number; forks: ReadonlyArray<Fork> } | null>(null)
  const [again, setAgain] = useState(0)
  const chat = view.chat
  const ready = chat !== null
  // What moves when the list may have changed; a reply only moves the shown fork's preview.
  const key = `${chat?.id}/${chat?.currentForkId}/${chat?.rowVersion}/${view.forkId}/${bump}/${again}`
  useEffect(() => {
    if (!ready) return
    let live = true
    void session
      .call((client) => client("ListForks", { chatId: session.id }))
      .then((result) => {
        if (live && result.ok) setRead({ key, bump, forks: result.value })
      })
    return () => {
      live = false
    }
    // `view.branchNames` changes as a branch is named in another tab, `key` the rest.
  }, [session, key, bump, ready, view.branchNames])
  const pending = (made.get(session.id) ?? []).filter(
    (m) => read !== null && m.bump > read.bump && !read.forks.some((f) => f.id === m.fork.id)
  )
  const forks =
    read === null
      ? null
      : pending.length === 0
        ? read.forks
        : [
            ...pending.map((m) => m.fork).reverse(),
            ...read.forks.map((f) => (f.current && pending.some((m) => m.fork.current) ? { ...f, current: false } : f))
          ]
  const shownId = view.forkId ?? chat?.currentForkId ?? null
  return { forks, shown: forks?.find((f) => f.id === shownId), reload: () => setAgain((n) => n + 1) }
}

// The ⋯ menu's "Branches…": a request the open chat's branch control answers.
let requested: { readonly chatId: ChatId } | null = null
const requestListeners = new Set<() => void>()
const subscribeRequests = (listener: () => void) => {
  requestListeners.add(listener)
  return () => requestListeners.delete(listener)
}
/** Opens the list of the chat's branches. */
export const requestBranches = (chatId: ChatId) => {
  requested = { chatId }
  for (const listener of requestListeners) listener()
}
/** The latest request, a new object each time. */
export const useBranchesRequest = () => useSyncExternalStore(subscribeRequests, () => requested)
