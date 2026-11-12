// Parallel threads in the client (spec/THREADS.md §13, TH3), registered as a plugin would:
// starting them from a message or the ⋯ menu, the branch control's thread label and Threads
// section, the timeline's row where they part, and the note editor's "Also change it in …".
// The left panel's Threads group is the shell's `threads` section (ShellBrowser.tsx).
import { branchControlParts } from "../chat/branchParts.ts"
import { chatCommands } from "../chat/commands.tsx"
import { messageActions, viewOf } from "../chat/messageActions.tsx"
import { chatNoteActions, chatOverlays } from "../chat/presentation.tsx"
import type { ChatSession, ChatView } from "../chat/session.ts"
import { timelineTransforms } from "../chat/timelineContributions.tsx"
import { AlsoChangeNote } from "./AlsoChangeNote.tsx"
import { listedAsBranch, ownThread, splitNumber, threadName } from "./model.ts"
import { START_HINT, StartThreadsCommandDialog, StartThreadsHereDialog } from "./StartThreadsDialog.tsx"
import { shownForkOf, threadSetsNow, useThreadSets } from "./threadSets.ts"
import { ThreadsSection } from "./ThreadsSection.tsx"
import { ThreadsTimelineRow } from "./ThreadsTimelineRow.tsx"

/** Reads the sets of the fork a chat shows, for the parts that read them synchronously. */
function ThreadsLoader({ session, view }: { session: ChatSession; view: ChatView }) {
  useThreadSets(session, view)
  return null
}

/** The sets the fork a view shows is in, as last read. */
const setsOf = (view: ChatView) => {
  const forkId = shownForkOf(view)
  return view.chat === null || forkId === null ? [] : (threadSetsNow(view.chat.id, forkId) ?? [])
}

export const register = () => [
  chatOverlays.register({ id: "threads.loader", order: 20, component: ThreadsLoader }),
  messageActions.register({
    id: "message.threads",
    order: 70,
    group: "place",
    describe: viewOf(({ openDialog }) => ({
      label: "Start parallel threads here…",
      icon: "threads",
      hint: START_HINT,
      onSelect: () => openDialog("message.threads")
    })),
    dialog: StartThreadsHereDialog
  }),
  chatCommands.register({
    id: "chat.threads",
    label: "Start parallel threads…",
    description:
      "From the newest message: two or more threads that run at the same time, each with its own characters, until you join them.",
    order: 2.55,
    icon: "threads",
    available: ({ view }) => view.chat !== null && view.entries.length > 0,
    dialog: StartThreadsCommandDialog
  }),
  branchControlParts.register({
    id: "threads",
    order: 10,
    trigger: ({ view }) => {
      const set = setsOf(view)[0]
      const thread = set && ownThread(set)
      if (!set || !thread) return null
      const name = threadName(thread, (id) => view.cast?.cards.find((card) => card.entityId === id)?.name ?? null)
      return {
        kind: "Thread",
        label: name,
        icon: "threads",
        hint: `Thread “${name}”, one of ${set.threads.length} that run at the same time from ${splitNumber(set)}. Switch threads or branches, rename them, or undo starting the threads.`
      }
    },
    // Another thread's forks are listed as threads, never as branches (DESIGN §3.3 [D]).
    listed: (fork, { shown }) => listedAsBranch(fork, shown),
    Section: ThreadsSection
  }),
  timelineTransforms.register({
    id: "timeline.threads",
    order: 30,
    transform: (rows, { view }) => {
      let result = rows
      for (const set of setsOf(view)) {
        const at = result.findIndex((row) => row.entry?.slotId === set.slotId)
        if (at < 0) continue
        result = [
          ...result.slice(0, at + 1),
          {
            key: `threads-${set.splitId}`,
            estimate: 48,
            from: Infinity,
            to: -1,
            render: ({ session }) => <ThreadsTimelineRow session={session} set={set} />
          },
          ...result.slice(at + 1)
        ]
      }
      return result
    }
  }),
  chatNoteActions.register({ id: "threads.also-change", order: 10, component: AlsoChangeNote })
]
