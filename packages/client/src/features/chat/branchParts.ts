// The header's branch control's extension points (spec/THREADS.md §13.2), so a feature can
// show other kinds of forks in it: what the trigger says ("Thread: At the docks ▾" for a
// thread), which forks the Branches list leaves out, and sections above that list. The threads
// feature registers one; a plugin can replace or add its own. A part reads stores of its own,
// so it says when what it returns changed (`branchPartsChanged`).
import type { Fork } from "@dreamspan/shared/chat.ts"
import { type ComponentType, useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import type { IconName } from "../../ui/Icon.tsx"
import type { ChatSession, ChatView } from "./session.ts"

export interface BranchControlContext {
  readonly session: ChatSession
  readonly view: ChatView
  /** The chat's live forks, as `ListForks` reads them. */
  readonly forks: ReadonlyArray<Fork>
  /** The fork shown. */
  readonly shown: Fork | undefined
}

/** What the trigger says in place of "Branch: …". */
export interface BranchTrigger {
  /** "Thread": before the label, as "Branch" is. */
  readonly kind: string
  readonly label: string
  readonly icon: IconName
  /** The trigger's explanation on hover. */
  readonly hint: string
}

export interface BranchRowNoteProps extends BranchControlContext {
  /** The row's fork. */
  readonly fork: Fork
}

export interface BranchSectionProps extends BranchControlContext {
  /** Closes the popover or sheet: after opening a fork, say. */
  readonly onDone: () => void
}

export const branchControlParts = makeRegistry<{
  readonly id: string
  readonly order: number
  /** False keeps the control in its loading state until this part knows the viewed line. */
  readonly ready?: (context: BranchControlContext) => boolean
  /** The first part to answer names the trigger; null: not this part's. */
  readonly trigger?: (context: BranchControlContext) => BranchTrigger | null
  /** A prefix identifying the viewed line in browser and workbench tabs. */
  readonly tabTitle?: (view: ChatView) => string | null
  /** False leaves the fork out of the Branches list. */
  readonly listed?: (fork: Fork, context: BranchControlContext) => boolean
  /** Shown above the Branches list. */
  readonly Section?: ComponentType<BranchSectionProps>
  /** A line under a branch row's name ("For the story's “Tavern fight”"); renders nothing when not its. */
  readonly RowNote?: ComponentType<BranchRowNoteProps>
}>()

let version = 0
const listeners = new Set<() => void>()
/** What a part returns may have changed: the control asks again. */
export const branchPartsChanged = () => {
  version++
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The parts in effect, in order; the control renders again when one says it changed. */
export const useBranchParts = () => {
  const parts = useSyncExternalStore(
    branchControlParts.subscribe,
    branchControlParts.snapshot,
    branchControlParts.snapshot
  )
  useSyncExternalStore(subscribe, () => version)
  return [...parts.entries].sort((a, b) => a.order - b.order)
}

/** Tab identity uses the same registered parts as the branch control, without another fork read. */
export const useBranchTabTitle = (view: ChatView) =>
  useBranchParts()
    .map((part) => part.tabTitle?.(view) ?? null)
    .find((title) => title !== null) ?? null
