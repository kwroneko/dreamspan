import { useSplitChats } from "./splitChats.ts"
// A chat's branches as the header lists them (DESIGN §3.2; the forks of
// spec/FORK-INDEPENDENCE-DELTA.md, which the UI calls branches): every live fork, with its
// name (`forkLabel`), its last message's first words and time. Read with `ListForks` when the
// chat opens and again whenever what it lists may have changed: the fork shown, the chat's
// record (its current fork), a branch's name, or a branch made, renamed or deleted here
// (`forksChanged`). How every list names a branch is here too (`forkLabel`).
import type { ChatId, Fork, ForkSplit } from "@rp/shared/chat.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import type { ChatSession, ChatView } from "./session.ts"

const momentFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit"
})
const thisYearFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit"
})

/** A date and time: "12 Jan, 21:40" this year, "12 Jan 2025, 21:40" before (in the reader's locale). */
export const formatMoment = (at: number, now = Date.now()) =>
  (new Date(at).getFullYear() === new Date(now).getFullYear() ? thisYearFormat : momentFormat).format(at)

/** What names a branch, from whichever read lists it: ListForks, the shell's rows, the bin. */
export interface BranchNaming {
  /** The name the user gave it (a branch they promoted); null or empty without one. */
  readonly name: string | null
  /** The chat's first fork, made from no other. */
  readonly original: boolean
  /** Where it parts from the fork it was made from, when the read knows. */
  readonly split?: ForkSplit | null | undefined
  readonly createdAt?: number | undefined
}

/** Where it splits off, time first: "12 Jan 2025, 21:40 at #14"; null where that isn't known. */
const splitText = (fork: Pick<BranchNaming, "split">, now = Date.now()) =>
  fork.split
    ? `${formatMoment(fork.split.at, now)} ${fork.split.after === 0 ? "at the start" : `at #${fork.split.after}`}`
    : null

/**
 * A branch as people read it, everywhere one is named (the sidebar, the header's Branch ▾, the
 * bin): the name the user gave it; else "Original" for the chat's first fork; else where it
 * splits off, the time first, "Split 12 Jan 2025, 21:40 at #14" (owner, 2026-11-01): the time
 * of its first own message (else its making) and the number of the last message it shares.
 * Never a file name: an ST import names no fork.
 */
export const forkLabel = (fork: BranchNaming, now = Date.now()) => {
  if (fork.name !== null && fork.name !== "") return fork.name
  if (fork.original) return "Original"
  const split = splitText(fork, now)
  if (split !== null) return `Split ${split}`
  return fork.createdAt === undefined ? "Branch" : `Made ${formatMoment(fork.createdAt, now)}`
}

/** `forkLabel` of a fork as ListForks reads it. */
export const branchLabel = (fork: Fork) =>
  forkLabel({ name: fork.name, original: fork.parentForkId === null, split: fork.split, createdAt: fork.createdAt })

/** Its last message's time, else when it was made. */
export const branchLastAt = (fork: Pick<Fork, "createdAt" | "endAt">) => fork.endAt ?? fork.createdAt

/** What the chat opening on a branch means, wherever it's marked. */
export const OPENS_HERE_HINT =
  "The chat opens on this branch: the one you last wrote in or made. An imported chat opens where it was last open."

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
  const split = useSplitChats(session.id, view.forkId)
  const grouped =
    split && forks
      ? forks.filter((f) => split.forkIds.includes(f.id)).map((f) => ({ ...f, current: f.id === split.group.forkId }))
      : forks
  const shownId = view.forkId ?? chat?.currentForkId ?? null
  return { forks: grouped, shown: grouped?.find((f) => f.id === shownId), reload: () => setAgain((n) => n + 1) }
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
