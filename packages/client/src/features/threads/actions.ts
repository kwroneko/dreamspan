// Opening a thread and undoing threads, from wherever they're shown (spec/THREADS.md §5.1,
// §13): the URL names the fork a tab shows, omitted for the one the chat opens on, and keeps
// the side panel open as it is.
import type { Chat, ForkId } from "@dreamspan/shared/chat.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useCallback } from "react"
import { showToast } from "../../ui/Toast.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { forksChanged } from "../chat/forks.ts"
import type { ChatSession } from "../chat/session.ts"
import { shownForkOf } from "./threadSets.ts"

/** The search a link to fork `forkId` carries: no `fork` for the one the chat opens on. */
export const forkSearch = (chat: Chat | null, forkId: ForkId, panel?: string): Record<string, string> => ({
  ...(panel ? { panel } : {}),
  ...(forkId === chat?.currentForkId ? {} : { fork: forkId })
})

/** The side panel the tab has open, kept by links to another fork. */
export const usePanel = () => (useSearch({ strict: false }) as { panel?: string }).panel

/** Shows fork `forkId` in this tab. */
export const useOpenFork = () => {
  const navigate = useNavigate()
  const panel = usePanel()
  return useCallback(
    (session: ChatSession, forkId: ForkId) =>
      void navigate({ to: ".", search: forkSearch(session.snapshot().chat, forkId, panel) }),
    [navigate, panel]
  )
}

/**
 * Undo of starting threads: the new threads go to the bin together (the toast's Undo restores
 * them) and the branch they were started in is as before. A tab showing one that went shows
 * that branch instead.
 */
export const useUndoThreads = () => {
  const navigate = useNavigate()
  const panel = usePanel()
  const deleted = useDeletedToast()
  return useCallback(
    async (session: ChatSession, set: { splitId: string; forkId: ForkId; removed: ReadonlyArray<ForkId> }) => {
      const result = await session.call((client) => client("UndoThreads", { chatId: session.id, splitId: set.splitId }))
      if (!result.ok)
        return void showToast({ title: "Couldn't undo starting the threads", description: result.error.message })
      forksChanged(session.id)
      deleted(result.value, () => forksChanged(session.id))
      const view = session.snapshot()
      const shown = shownForkOf(view)
      if (shown !== null && set.removed.includes(shown))
        void navigate({ to: ".", search: forkSearch(view.chat, set.forkId, panel), replace: true })
    },
    [navigate, panel, deleted]
  )
}
