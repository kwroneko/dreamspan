// The branch control's Threads section (spec/THREADS.md §13.2): above the Branches list, one
// row per thread of each set the fork shown is in, innermost set first, then the threads of sets
// it's outside, so another thread is never listed as a branch (DESIGN §3.3 [D]). A row opens its
// thread (a link: a middle-click opens it in a new tab), shows its characters' faces, the start
// of its last message and when that was, and renames it; each set has its Undo.
import type { EntityId, Fork, ForkId } from "@rp/shared/chat.ts"
import type { ThreadInfo, ThreadSet } from "@rp/shared/threads.ts"
import { Link, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { Avatar, PortraitOverflow } from "../../ui/Avatar.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { ContextMenu, MenuItem } from "../../ui/Menu.tsx"
import { OPEN_BESIDE_HINT, openBeside, useCanOpenBeside } from "../workbench/OpenBeside.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import type { BranchSectionProps } from "../chat/branchParts.ts"
import { useCast } from "../chat/cast.ts"

import { branchLastAt, formatMoment, forksChanged } from "../chat/forks.ts"
import type { ChatSession } from "../chat/session.ts"
import { forkSearch, useOpenFork, usePanel, useUndoThreads } from "./actions.ts"
import { otherSplits, splitNumber, threadName } from "./model.ts"
import { useThreadSets, useThreadSetsOf, useThreadsVersion } from "./threadSets.ts"

/** Undo's explanation, wherever threads are shown. */
export const UNDO_HINT =
  "Moves the new threads and their messages to the bin. This branch keeps its messages; who was marked away or back at the start is undone. Branches made from the new threads stay. You can restore the threads from the bin."

function ThreadRow({
  session,
  set,
  thread,
  forks,
  shown,
  onDone
}: {
  session: ChatSession
  set: ThreadSet
  thread: ThreadInfo
  forks: ReadonlyArray<Fork>
  shown: boolean
  onDone: () => void
}) {
  const [menu, setMenu] = useState(false)
  const router = useRouter()
  const canBeside = useCanOpenBeside()
  const view = session.snapshot()
  const cast = useCast()
  const panel = usePanel()
  const openFork = useOpenFork()
  const [renaming, setRenaming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const name = threadName(thread, (id) => cast.cards.get(id)?.name ?? null)
  const opens = forks.find((fork) => fork.id === thread.openForkId)
  const faces = thread.cast.flatMap((id: EntityId) => cast.cards.get(id) ?? [])
  const rename = async (next: string) => {
    const result = await session.call((client) =>
      client("RenameThread", {
        chatId: session.id,
        splitId: set.splitId,
        ordinal: thread.ordinal,
        name: next,
        rowVersion: thread.rowVersion
      })
    )
    setFailure(result.ok ? null : result.error.message)
    if (result.ok) forksChanged(session.id)
    return result.ok
  }
  const open = () => {
    onDone()
    if (!shown && thread.openForkId !== null) openFork(session, thread.openForkId)
  }
  const href =
    thread.openForkId === null
      ? ""
      : router.buildLocation({
          to: "/chats/$chatId",
          params: { chatId: session.id },
          search: forkSearch(view.chat, thread.openForkId, panel)
        }).href
  return (
    <div
      data-thread-row={thread.ordinal}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (thread.openForkId !== null && !target.closest("button, input, a")) open()
      }}
      className={`relative grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border p-2 ${shown ? "border-accent bg-surface-raised" : "border-border hover:bg-surface-raised"}`}
    >
      <div data-row-text className="min-w-0">
        <div data-branch-title-line className="flex h-5 min-w-0 items-center gap-x-1 text-sm">
          <InlineRename
            compact
            value={thread.name ?? ""}
            label={name}
            fieldLabel={`Name of thread ${name}`}
            hint="Renames this thread, in all its branches."
            allowEmpty
            maxLength={100}
            placeholder={name}
            className={renaming ? "min-w-0 flex-1" : "min-w-0"}
            onEditingChange={setRenaming}
            onRename={rename}
          >
            <span data-layout-name className="min-w-0 truncate font-medium">
              {name}
            </span>
          </InlineRename>
          {shown && !renaming && (
            <span className="ms-auto flex shrink-0">
              <Badge>this one</Badge>
            </span>
          )}
        </div>
        <ContextMenu
          label={`Actions for thread ${name}`}
          open={menu}
          onOpenChange={setMenu}
          trigger={
            <Tooltip
              label={
                thread.openForkId === null
                  ? "This thread has no branch left."
                  : `Opens this thread${shown ? ", shown now" : ""}.`
              }
            >
              {thread.openForkId === null ? (
                <span className="block text-xs text-muted">No branch left</span>
              ) : (
                <Link
                  to="/chats/$chatId"
                  params={{ chatId: session.id }}
                  search={forkSearch(view.chat, thread.openForkId, panel)}
                  aria-current={shown || undefined}
                  aria-label={`Thread ${name}${shown ? ", shown" : ""}: ${opens?.tipExcerpt.slice(0, 80) || "no messages since the threads started"}`}
                  onClick={openOnPlainClick(open)}
                  className="block w-full min-w-0 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span className="line-clamp-2 min-h-8 text-xs text-muted [overflow-wrap:anywhere]">
                    {opens?.tipExcerpt || "No messages yet"}
                  </span>
                  <span data-row-when className="block text-xs text-muted tabular-nums">
                    since {splitNumber(set)}
                    {thread.joined ? ` · Joined at #${thread.joined.number}` : ""}
                    {opens ? ` · Last message ${formatMoment(branchLastAt(opens))}` : ""}
                  </span>
                </Link>
              )}
            </Tooltip>
          }
        >
          <MenuItem
            icon="threads"
            description="Opens this thread here."
            disabled={thread.openForkId === null}
            onClick={open}
          >
            Open
          </MenuItem>
          {canBeside && (
            <MenuItem
              icon="split-right"
              description={OPEN_BESIDE_HINT}
              disabled={thread.openForkId === null}
              onClick={() => {
                onDone()
                openBeside(href)
              }}
            >
              Open beside
            </MenuItem>
          )}
          <MenuItem
            icon="external"
            description="Opens this thread in a new browser tab."
            disabled={thread.openForkId === null}
            onClick={() => window.open(href, "_blank", "noopener")}
          >
            Open in a new browser tab
          </MenuItem>
        </ContextMenu>
        {failure !== null && (
          <p role="alert" className="text-xs text-danger">
            {failure}
          </p>
        )}
      </div>
      {faces.length > 0 && (
        <Tooltip label={`In this thread: ${faces.map((face) => face.name).join(", ")}`}>
          <span
            tabIndex={0}
            data-row-portraits
            aria-label={`In this thread: ${faces.map((face) => face.name).join(", ")}`}
            data-layout-audit-ignore="overlap: The overflow count is tucked behind the second full portrait; gap: The count tile intentionally overlaps the second portrait"
            className="relative flex shrink-0 items-center gap-0.5 self-start rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {faces.slice(0, 2).map((face) => (
              <Avatar
                key={face.entityId}
                id={face.entityId}
                name={face.name}
                mediaId={face.avatarMediaId}
                crop={face.avatarCrop}
                size="xs"
              />
            ))}
            <PortraitOverflow remaining={faces.length - 2} size="xs" />
          </span>
        </Tooltip>
      )}
    </div>
  )
}

function SetRows({
  session,
  set,
  forks,
  shownFork,
  onDone
}: {
  session: ChatSession
  set: ThreadSet
  forks: ReadonlyArray<Fork>
  shownFork: Fork | undefined
  onDone: () => void
}) {
  const undo = useUndoThreads()
  const shownPlace = shownFork?.threads?.find((place) => place.splitId === set.splitId)
  return (
    <section
      data-thread-set={set.splitId}
      aria-label={`Threads from ${splitNumber(set)}`}
      className="flex shrink-0 flex-col gap-1"
    >
      <div className="flex min-w-0 items-center gap-1 ps-1 pe-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-muted">Threads from {splitNumber(set)}</h3>
        <IconButton
          label={`Undo starting the threads from ${splitNumber(set)}`}
          hint={UNDO_HINT}
          icon="undo"
          onClick={() => {
            onDone()
            void undo(session, {
              splitId: set.splitId,
              forkId: set.forkId,
              removed: set.threads.filter((thread) => thread.starts).map((thread) => thread.forkId)
            })
          }}
        />
      </div>
      {set.threads.map((thread) => (
        <ThreadRow
          key={thread.ordinal}
          session={session}
          set={set}
          thread={thread}
          forks={forks}
          shown={shownPlace?.ordinal === thread.ordinal}
          onDone={onDone}
        />
      ))}
    </section>
  )
}

/** Registered as the threads part's `Section`. */
export function ThreadsSection({ session, view, forks, shown, onDone }: BranchSectionProps) {
  const own = useThreadSets(session, view) ?? []
  const version = useThreadsVersion(session, view)
  const others = otherSplits(forks, new Set(own.map((set) => set.splitId)))
  const read = useThreadSetsOf(
    session,
    view.chat?.id ?? null,
    others.map((other) => other.forkId),
    version
  )
  const foreign = others.flatMap(
    (other) => read.get(other.forkId as ForkId)?.find((set) => set.splitId === other.splitId) ?? []
  )
  const sets = [...own, ...foreign]
  if (sets.length === 0) return null
  return (
    <div
      data-threads-section
      className="-mx-3 mb-2 flex max-h-[50dvh] min-h-0 shrink flex-col gap-2 overflow-y-auto border-b border-border px-3 pt-2 pb-2"
    >
      {sets.map((set) => (
        <SetRows key={set.splitId} session={session} set={set} forks={forks} shownFork={shown} onDone={onDone} />
      ))}
    </div>
  )
}
