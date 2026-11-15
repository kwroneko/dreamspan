// Parallel threads in the client (spec/THREADS.md §13, TH3), registered as a plugin would:
// starting them from a message or the ⋯ menu, the branch control's thread label and Threads
// section, the timeline's row where they part, the note editor's "Also change it in …", sending
// to several threads and joining them (the merge dialog's thread mode).
// The left panel's Threads group is the shell's `threads` section (ShellBrowser.tsx).
import { branchControlParts } from "../chat/branchParts.ts"
import { listNames } from "../chat/cast.ts"
import { chatCommands } from "../chat/commands.tsx"
import { composerControls, composerSendRoutes } from "../chat/composerControls.tsx"
import { messageActions, messageDeleteOffers, viewOf } from "../chat/messageActions.tsx"
import { messageSaveOptions } from "../chat/editorHistory.tsx"
import { messageDetails } from "../chat/messageDetails.tsx"
import { AlsoIn, copyDeleteActions, SaveInAll } from "./copies.tsx"
import { chatNoteActions, chatOverlays } from "../chat/presentation.tsx"
import type { ChatSession, ChatView } from "../chat/session.ts"
import { threadsTimeline } from "../chat/timelineParts.ts"
import {
  timelineTransforms,
  timelinePart,
  timelineDataSources,
  timelineBodies
} from "../chat/timelineContributions.tsx"
import { AlsoChangeNote } from "./AlsoChangeNote.tsx"
import { JOIN_HINT, JoinThreadsCommandDialog, JoinThreadsHereDialog, joinOffered } from "./JoinThreadsDialog.tsx"
import { listedAsBranch, ownThread, splitNumber, threadName } from "./model.ts"
import { START_HINT, StartThreadsCommandDialog, StartThreadsHereDialog } from "./StartThreadsDialog.tsx"
import { SendToThreadsChip } from "./SendToThreadsChip.tsx"
import { sendToThreads, subscribeTicks, ticked } from "./sendTargets.ts"
import { shownForkOf, subscribeThreadSets, threadSetsNow, useThreadSets } from "./threadSets.ts"
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
  // Joining (§7.1): offered while another thread has something not yet joined here.
  messageActions.register({
    id: "message.join-thread",
    order: 72,
    group: "place",
    available: ({ entry, session }) => entry.version.origin !== "merge" && joinOffered(session.snapshot()),
    describe: viewOf(({ openDialog }) => ({
      label: "Join a thread here…",
      icon: "threads",
      hint: `${JOIN_HINT} Joins after this message.`,
      onSelect: () => openDialog("message.join-thread")
    })),
    dialog: JoinThreadsHereDialog
  }),
  chatCommands.register({
    id: "chat.join-threads",
    label: "Join threads…",
    description: `After the newest message. ${JOIN_HINT}`,
    order: 2.56,
    icon: "threads",
    available: ({ view }) => joinOffered(view),
    dialog: JoinThreadsCommandDialog
  }),
  branchControlParts.register({
    id: "threads",
    order: 10,
    ready: ({ view }) => {
      const forkId = shownForkOf(view)
      return view.chat !== null && view.cast !== null && forkId !== null && threadSetsNow(view.chat.id, forkId) !== null
    },
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
    tabTitle: (view) => {
      const set = setsOf(view)[0]
      const thread = set && ownThread(set)
      return thread
        ? `Thread: ${threadName(thread, (id) => view.cast?.cards.find((card) => card.entityId === id)?.name ?? null)}`
        : null
    },
    // Another thread's forks are listed as threads, never as branches (DESIGN §3.3 [D]).
    listed: (fork, { shown }) => listedAsBranch(fork, shown),
    Section: ThreadsSection
  }),
  timelineDataSources.register({
    id: "threads",
    source: import.meta.url,
    threads: (view) => setsOf(view).map((set) => ({ splitId: set.splitId, slotId: set.slotId }))
  }),
  timelineBodies.register({
    id: "threads",
    source: import.meta.url,
    row: (body, context, fields) => {
      const set = setsOf(context.view).find((set) => set.splitId === body.ref)
      if (!set) throw new Error("Unknown thread")
      return { ...fields, render: ({ session }) => <ThreadsTimelineRow session={session} set={set} /> }
    }
  }),
  timelineTransforms.register(timelinePart(threadsTimeline)),
  chatNoteActions.register({ id: "threads.also-change", order: 10, component: AlsoChangeNote }),
  // Sending to several threads (§6): the strip's chip, and the send it takes over once one is ticked.
  composerControls.register({ id: "composer.threads", order: 35, placement: "strip", component: SendToThreadsChip }),
  composerSendRoutes.register({
    id: "threads.send",
    order: 10,
    subscribe: (listener) => {
      const ticks = subscribeTicks(listener)
      const sets = subscribeThreadSets(listener)
      return () => {
        ticks()
        sets()
      }
    },
    takes: (_session, view) => ticked(view).length > 0,
    hint: (_session, view) =>
      ` here and in ${listNames(
        ticked(view).map(
          (other) =>
            `“${threadName(other.thread, (id) => view.cast?.cards.find((card) => card.entityId === id)?.name ?? null)}”`
        )
      )}`,
    send: sendToThreads
  }),
  // A message sent to several threads, afterwards (§6.3): the link to each copy, Save in both, and
  // deleting the other copy too.
  messageDetails.register({
    id: "message.also-in",
    place: "header",
    order: 50,
    label: "Copies in other threads",
    description: "For a message sent to several threads: a link to its copy in each other one.",
    component: AlsoIn
  }),
  messageSaveOptions.register({
    id: "threads.save-all",
    order: 10,
    offers: (entry) =>
      (entry.copies?.length ?? 0) > 0 && entry.version.writer === "human" ? { here: "Save here" } : null,
    component: SaveInAll
  }),
  messageDeleteOffers.register({ id: "threads.delete-copy", order: 10, actions: copyDeleteActions })
]
