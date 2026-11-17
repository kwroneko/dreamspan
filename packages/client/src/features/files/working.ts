// The working folder as the Files tab sees it (spec/FILES-AND-ENVIRONMENT.md §2.1, §8.1): the
// branch's `workshop.folder`, which the folder chip's part (track A1) owns and writes. That part
// registers a source here; without one the tab opens at the top of Files and offers no Set as
// working folder.
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import type { ChatSession, ChatView } from "../chat/session.ts"
import type { WorkingFolder } from "./FileBrowser.tsx"

export interface WorkingFolderSource {
  readonly id: string
  /** A hook: the chat's working folder on the branch shown, or null where it has none. */
  readonly useWorkingFolder: (session: ChatSession, view: ChatView) => WorkingFolder | null
}

/** @public The folder chip's part (track A1) registers here. */
export const workingFolderSources = makeRegistry<WorkingFolderSource>()

export const useWorkingFolderSource = () => {
  const snapshot = useSyncExternalStore(
    workingFolderSources.subscribe,
    workingFolderSources.snapshot,
    workingFolderSources.snapshot
  )
  return snapshot.entries.at(-1) ?? null
}
