import type { ForkSplit } from "./chat.ts"

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

/** Saved display naming data, rendered in the reader's locale like the branch menu. */
export interface StoryScope {
  readonly branch: BranchNaming
  readonly first: number
  readonly last: number
  readonly from?: boolean
}
export const storyScopeText = (scope: StoryScope) =>
  `Branch “${forkLabel(scope.branch)}” · ${scope.from ? "from message" : "messages"} ${scope.first}${scope.from ? "" : `–${scope.last}`}`
