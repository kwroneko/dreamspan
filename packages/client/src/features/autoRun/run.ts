// Auto replies (DESIGN §2.3; ST's auto mode, bounded): the characters reply to each other for a
// set number of turns with nothing sent from the user. The run lives in the tab that started
// it and is driven from there: each turn is the same request ▶ Reply now makes, started only
// after the one before it finished and only while everything is as the run left it. Anything
// else ends it. This file is the run's state and its one rule (`stepOf`); AutoRun.tsx drives it.
import type { EntityId, SlotId, VersionId } from "@rp/shared/chat.ts"

/** Why a run ended. */
export type AutoStop =
  | "done"
  | "tokens"
  | "you"
  | "typed"
  | "queued"
  | "moved"
  | "branch"
  | "picked"
  | "nobody"
  | "failed"
  | "stopped"
  | "approval"
  | "error"
  | "uncounted"
  | "left"
  | "disconnected"
  | "settings"
  | "restarted"

export interface Tip {
  readonly slotId: SlotId
  readonly versionId: VersionId
}

export interface AutoRun {
  readonly id: number
  readonly forkId: string | null
  /** How many replies it may ask for, and how many finished. */
  readonly turns: number
  readonly done: number
  readonly asked: number
  /** Hard ceiling on reported output across reply requests; null: no token bound. */
  readonly tokenLimit: number | null
  readonly tokens: number
  /** Requests its replies made, as the usage ledger counted them. */
  readonly requests: number
  /** The chat's last message as the run left it: its own last reply, or the tip it started at. */
  readonly tip: Tip | null
  /** The reply being written for it. */
  readonly waiting: Tip | null
  /**
   * What the server handed back for its last turn, which the next must present: the server
   * starts that turn only if nothing changed since that the run didn't cause. Null: the next
   * turn is the user's own click (Start, Continue), which starts a run on the server.
   */
  readonly token: string | null
  /** A request to start a reply, or to read one's usage, is out. */
  readonly pending: "start" | "count" | null
  readonly stop: AutoStop | null
  /** The server's message when a reply couldn't be started. */
  readonly error?: string
}

/** What the tab shows now. */
export interface Seen {
  readonly forkId: string | null
  /** The messages shown reach the chat's end and aren't being read again. */
  readonly atLeaf: boolean
  readonly leaf: (Tip & { readonly status: string; readonly empty?: boolean }) | null
  readonly hasText: boolean
  readonly queued: number
  /** Auto's pick for the next reply. */
  readonly replier: EntityId | null
  /** The user chose who replies next (a pick, or No one), so it isn't Auto's turn to choose. */
  readonly picked: boolean
  readonly candidates: number
  readonly ready: boolean
  readonly busy: boolean
  /** The reply being written waits for a tool's approval. */
  readonly approval: boolean
}

export type Step =
  | { readonly do: "wait" }
  | { readonly do: "stop"; readonly why: AutoStop }
  | { readonly do: "count"; readonly versionId: VersionId }
  | { readonly do: "start" }

export const MAX_TURNS = 50

let runs = 0
export const newRun = (forkId: string | null, turns: number, tokenLimit: number | null, tip: Tip | null): AutoRun => ({
  id: ++runs,
  forkId,
  turns,
  done: 0,
  asked: 0,
  tokenLimit,
  tokens: 0,
  requests: 0,
  tip,
  waiting: null,
  token: null,
  pending: null,
  stop: null
})

const same = (a: Tip | null, b: Tip | null) => a?.slotId === b?.slotId && a?.versionId === b?.versionId

/**
 * What the run does next, from what the tab shows. It starts a reply only when the last message
 * is the one it left, complete, with nothing typed, queued or chosen, and bounds left; it ends
 * on anything it didn't do itself.
 */
export const stepOf = (run: AutoRun, seen: Seen): Step => {
  if (run.stop !== null) return { do: "wait" }
  if (seen.forkId !== run.forkId) return { do: "stop", why: "branch" }
  if (seen.hasText) return { do: "stop", why: "typed" }
  if (seen.queued > 0) return { do: "stop", why: "queued" }
  if (seen.picked) return { do: "stop", why: "picked" }
  if (seen.approval) return { do: "stop", why: "approval" }
  if (run.pending !== null || !seen.atLeaf) return { do: "wait" }
  if (run.waiting !== null) {
    if (!same(seen.leaf, run.waiting)) return { do: "stop", why: "moved" }
    switch (seen.leaf!.status) {
      case "generating":
        return seen.approval ? { do: "stop", why: "approval" } : { do: "wait" }
      case "complete":
        if (seen.leaf!.empty) return { do: "stop", why: "failed" }
        return { do: "count", versionId: run.waiting.versionId }
      case "stopped":
        return { do: "stop", why: "stopped" }
      default:
        return { do: "stop", why: "failed" }
    }
  }
  if (!same(seen.leaf, run.tip) || (seen.leaf !== null && seen.leaf.status !== "complete"))
    return { do: "stop", why: "moved" }
  if (run.asked >= run.turns) return { do: "stop", why: "done" }
  if (run.tokenLimit !== null && run.tokens >= run.tokenLimit) return { do: "stop", why: "tokens" }
  // Who replies next isn't known while the composer is still reading it.
  if (!seen.ready || seen.busy) return { do: "wait" }
  if (seen.picked) return { do: "stop", why: "picked" }
  if (seen.candidates < 2 || seen.replier === null) return { do: "stop", why: "nobody" }
  return { do: "start" }
}

export const stopped = (run: AutoRun, why: AutoStop, error?: string): AutoRun =>
  run.stop !== null ? run : { ...run, stop: why, ...(error === undefined ? {} : { error }) }

export const starting = (run: AutoRun): AutoRun => ({ ...run, asked: run.asked + 1, pending: "start" })
export const started = (run: AutoRun, reply: Tip, token: string | null): AutoRun => ({
  ...run,
  token,
  pending: null,
  waiting: reply
})
export const counting = (run: AutoRun): AutoRun => ({ ...run, pending: "count" })
/** A reply finished: it's the tip the next turn must find, and its usage counts toward the bounds. */
export const counted = (run: AutoRun, usage: { readonly tokens: number; readonly requests: number }): AutoRun => ({
  ...run,
  pending: null,
  done: run.done + 1,
  tokens: run.tokens + usage.tokens,
  requests: run.requests + usage.requests,
  tip: run.waiting,
  waiting: null
})

/** The same bounds, carried on from where it stopped: only by the user's own click. */
export const resumed = (run: AutoRun, tip: Tip | null): AutoRun => ({
  ...run,
  id: ++runs,
  stop: null,
  token: null,
  pending: null,
  waiting: null,
  tip
})

/** Whether a stopped run has turns and tokens left to carry on with. */
export const canResume = (run: AutoRun) =>
  run.stop !== null &&
  run.stop !== "done" &&
  run.stop !== "tokens" &&
  run.asked < run.turns &&
  run.pending === null &&
  run.waiting === null &&
  (run.tokenLimit === null || run.tokens < run.tokenLimit)

const replies = (count: number) => (count === 1 ? "1 reply" : `${count} replies`)

/** Why it ended, for the row: plain, no internals. */
export const stopText = (run: AutoRun): string => {
  const progress = `after ${run.done} of ${run.turns}`
  switch (run.stop) {
    case null:
      return ""
    case "done":
      return `Done: ${replies(run.done)}.`
    case "tokens":
      return `Stopped ${progress}: the token limit was reached.`
    case "you":
      return `Stopped ${progress}.`
    case "typed":
      return `Stopped ${progress}: you started typing.`
    case "queued":
      return `Stopped ${progress}: a message was sent or queued.`
    case "moved":
      return `Stopped ${progress}: the chat changed.`
    case "branch":
      return `Stopped ${progress}: you switched branch.`
    case "picked":
      return `Stopped ${progress}: you chose who replies next.`
    case "nobody":
      return `Stopped ${progress}: fewer than two characters can reply.`
    case "failed":
      return `Stopped ${progress}: a reply failed.`
    case "stopped":
      return `Stopped ${progress}: a reply was stopped.`
    case "approval":
      return `Stopped ${progress}: a tool is waiting for your approval.`
    case "uncounted":
      return `Stopped ${progress}: the last reply's token count couldn't be read.`
    case "disconnected":
      return `Stopped ${progress}: the connection was lost.`
    case "left":
      return `Stopped ${progress}: you left the chat or branch.`
    case "settings":
      return `Stopped ${progress}: a setting, preset, model or library entry changed.`
    case "restarted":
      return `Stopped ${progress}: the server restarted.`
    case "error":
      return `Stopped ${progress}: ${run.error ?? "the next reply couldn't be started."}`
  }
}

/** A tiny store per chat session: the run is the tab's, never saved. */
export interface RunStore {
  readonly get: () => AutoRun | null
  readonly set: (run: AutoRun | null) => void
  /** Applies `change` to the run with this id, if it's still the one. */
  readonly update: (id: number, change: (run: AutoRun) => AutoRun) => AutoRun | null
  readonly subscribe: (listener: () => void) => () => void
}

export const makeRunStore = (): RunStore => {
  let run: AutoRun | null = null
  const listeners = new Set<() => void>()
  const set = (next: AutoRun | null) => {
    if (next === run) return
    run = next
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => run,
    set,
    update: (id, change) => {
      if (run === null || run.id !== id) return null
      set(change(run))
      return run
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}

const stores = new WeakMap<object, RunStore>()
export const runStoreOf = (session: object): RunStore => {
  let store = stores.get(session)
  if (!store) stores.set(session, (store = makeRunStore()))
  return store
}

/** The dialog's fields as numbers: null where a field doesn't hold a usable one. */
export const parseBounds = (turns: string, tokens: string) => {
  const count = /^\d+$/.test(turns.trim()) ? Number(turns.trim()) : NaN
  const limit = tokens.trim() === "" ? null : /^\d+$/.test(tokens.trim()) ? Number(tokens.trim()) : NaN
  return {
    turns: Number.isInteger(count) && count >= 1 && count <= MAX_TURNS ? count : null,
    tokenLimit:
      limit === null ? null : Number.isSafeInteger(limit) && limit >= 1 && limit <= 2147483647 ? limit : undefined
  }
}
