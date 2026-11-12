// "Start parallel threads" (spec/THREADS.md §5.1; DESIGN §3.3 [D]): from a message's actions
// at that message, from the ⋯ menu at the newest. Rows for the threads, This branch first
// (it goes on as the first thread), each with a name, who's in it and who the user writes as
// there; at an earlier message, what happens to the messages after it ([D] owner, 2026-11-12).
// Afterwards the user stays where they were; the toast opens the new thread or undoes it.
import type { CastCard, EntityId, ForkId, PathEntry } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Select } from "../../ui/Select.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { listNames } from "../chat/cast.ts"
import type { ChatCommandDialogProps } from "../chat/commands.tsx"
import { forksChanged } from "../chat/forks.ts"
import type { MessageActionProps } from "../chat/messageActions.tsx"
import { positionOf } from "../chat/position.ts"
import type { ChatSession } from "../chat/session.ts"
import { useOpenFork, useUndoThreads } from "./actions.ts"
import {
  defaultWritesAs,
  type DraftThread,
  initialThreads,
  playedLine,
  startCast,
  startProblem,
  startRequest
} from "./model.ts"
import { shownForkOf } from "./threadSets.ts"

/** The hover on the action and the command: what threads are. */
export const START_HINT =
  "Continue from this message in two or more threads that run at the same time, each with its own characters, until you join them."
const CAST_HINT = "Who is in this thread. The others are away in it."
const AS_NOW = "as-now"
/** The server's bound on one start (`StartThreadsInput`). */
const MAX_THREADS = 32

function CastChip({
  card,
  pressed,
  mine,
  onToggle
}: {
  card: CastCard | undefined
  pressed: boolean
  mine: boolean
  onToggle: () => void
}) {
  const name = card?.name ?? "A card"
  return (
    <Tooltip label={`${CAST_HINT}${mine ? " This is one of your cards." : ""}`}>
      <button
        type="button"
        data-thread-cast={card?.entityId}
        aria-pressed={pressed}
        onClick={onToggle}
        className="inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full border border-border px-2.5 text-xs text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus aria-pressed:border-accent aria-pressed:bg-accent/10 aria-pressed:text-text"
      >
        {pressed && <Icon name="check" size={12} className="shrink-0" />}
        {mine && <Icon name="person" size={12} className="shrink-0" />}
        <span className="truncate">{name}</span>
      </button>
    </Tooltip>
  )
}

function ThreadRow({
  thread,
  index,
  cast,
  cards,
  onChange,
  onRemove
}: {
  thread: DraftThread
  index: number
  cast: ReturnType<typeof startCast>
  cards: ReadonlyMap<string, CastCard>
  onChange: (next: DraftThread) => void
  onRemove: (() => void) | null
}) {
  const title = index === 0 ? "This branch" : index === 1 ? "New thread" : `Thread ${index + 1}`
  const nameOf = (id: EntityId) => cards.get(id)?.name ?? "A card"
  const people = [...cast.characters, ...cast.mine]
  const choices = [...new Set([...cast.mine, ...cast.narrators, ...thread.cast])]
  const automatic = index === 0 ? null : defaultWritesAs(thread, cast)
  const items = [
    ...(index === 0
      ? [{ value: AS_NOW, label: "As now", description: "Whoever this branch's composer writes as now." }]
      : []),
    ...choices.map((id) => ({
      value: id as string,
      label: nameOf(id),
      ...(cast.narrators.includes(id) ? { description: "A narrator: in every thread." } : {})
    }))
  ]
  const value = thread.writesAs ?? automatic ?? (index === 0 ? AS_NOW : null)
  return (
    <section
      data-thread-row={index}
      aria-label={title}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h3>
        {onRemove && (
          <IconButton label={`Remove ${title}`} hint="Leaves this thread out." icon="close" onClick={onRemove} />
        )}
      </div>
      <Field label="Name">
        <Input
          value={thread.name}
          maxLength={100}
          placeholder={listNames(thread.cast.filter((id) => cast.characters.includes(id)).map(nameOf)) || "Name"}
          onChange={(event) => onChange({ ...thread, name: event.currentTarget.value })}
        />
      </Field>
      <div role="group" aria-label={`Who is in ${title}`} className="flex min-w-0 flex-wrap gap-1.5">
        {people.map((id) => (
          <CastChip
            key={id}
            card={cards.get(id)}
            mine={cast.mine.includes(id)}
            pressed={thread.cast.includes(id)}
            onToggle={() =>
              onChange({
                ...thread,
                cast: thread.cast.includes(id) ? thread.cast.filter((c) => c !== id) : [...thread.cast, id]
              })
            }
          />
        ))}
      </div>
      <Field label="Writes as">
        <Select
          items={items}
          value={value}
          placeholder="Nobody yet"
          onValueChange={(next) => onChange({ ...thread, writesAs: next === AS_NOW ? null : (next as EntityId) })}
        />
      </Field>
    </section>
  )
}

/** The dialog for a message of the fork shown: `entry`, and the newest message's position when known. */
function StartThreadsDialog({
  session,
  entry,
  last,
  onClose
}: {
  session: ChatSession
  entry: PathEntry
  last: number | null
  onClose: () => void
}) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const forkId = shownForkOf(view)
  const openFork = useOpenFork()
  const undo = useUndoThreads()
  const [read, setRead] = useState<Cast | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [threads, setThreads] = useState<ReadonlyArray<DraftThread> | null>(null)
  const [pending, setPending] = useState(false)
  // Who's in the chat at this message, not at the newest.
  useEffect(() => {
    let live = true
    void session
      .call((client) => client("GetCast", { chatId: session.id, forkId, slotId: entry.slotId }))
      .then((result) => {
        if (!live) return
        if (!result.ok) return setFailure(result.error.message)
        setRead(result.value)
        setThreads(initialThreads(startCast(result.value)))
      })
    return () => {
      live = false
    }
  }, [session, forkId, entry.slotId])
  const at = positionOf(entry)
  const cast = read ? startCast(read) : null
  const cards = new Map((read?.cards ?? []).map((card) => [card.entityId as string, card]))
  const problem = cast && threads ? startProblem(threads, cast) : null
  const moved =
    cast && threads
      ? cast.characters.filter((id) => !threads[0]!.cast.includes(id)).map((id) => cards.get(id)?.name ?? "A card")
      : []
  const earlier = last === null || last > at
  const start = async () => {
    if (!cast || !threads || forkId === null || problem !== null) return
    setPending(true)
    const result = await session.call((client) =>
      client("StartThreads", {
        chatId: session.id,
        forkId,
        slotId: entry.slotId,
        expectedRowVersion: entry.rowVersion,
        threads: startRequest(threads, cast)
      })
    )
    setPending(false)
    if (!result.ok) return setFailure(result.error.message)
    forksChanged(session.id)
    onClose()
    const started = result.value
    const second = threads[1]!
    const secondName =
      second.name.trim() ||
      listNames(
        second.cast.filter((id) => cast.characters.includes(id)).map((id) => cards.get(id)?.name ?? "A card")
      ) ||
      "the new thread"
    showToast({
      title: "Threads started",
      description: `From #${at + 1}. You're still in this branch, its first thread.`,
      actions: [
        {
          label: `Open “${secondName}”`,
          hint: "Shows the new thread here. A middle-click on its link in the timeline opens it in a new tab.",
          onClick: () => openFork(session, started.forkIds[1]!)
        },
        {
          label: "Undo",
          hint: "Moves the new threads to the bin; this branch is as it was.",
          onClick: () =>
            void undo(session, {
              splitId: started.splitId,
              forkId: started.forkIds[0]!,
              removed: started.forkIds.slice(1) as ReadonlyArray<ForkId>
            })
        }
      ]
    })
  }
  const narrators = cast?.narrators.map((id) => cards.get(id)?.name ?? "A narrator") ?? []
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Threads from #${at + 1}`}
      description={START_HINT}
      placement="top"
    >
      {threads === null || cast === null ? (
        failure === null ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Reading who is here at this message…
          </p>
        ) : null
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {threads.map((thread, index) => (
            <ThreadRow
              key={thread.key}
              thread={thread}
              index={index}
              cast={cast}
              cards={cards}
              onChange={(next) => setThreads(threads.map((t) => (t.key === thread.key ? next : t)))}
              onRemove={index < 2 ? null : () => setThreads(threads.filter((t) => t.key !== thread.key))}
            />
          ))}
          <div>
            <Button
              variant="ghost"
              disabled={threads.length >= MAX_THREADS}
              focusableWhenDisabled
              hint={
                threads.length >= MAX_THREADS
                  ? `At most ${MAX_THREADS} threads start together.`
                  : "Adds another thread, with nobody in it yet."
              }
              onClick={() =>
                setThreads([
                  ...threads,
                  { key: Math.max(...threads.map((t) => t.key)) + 1, name: "", cast: [], writesAs: null }
                ])
              }
            >
              <Icon name="plus" size={16} /> Add a thread
            </Button>
          </div>
          {narrators.length > 0 && (
            <p className="text-sm text-muted">
              {listNames(narrators)} {narrators.length === 1 ? "is" : "are"} in every thread.
            </p>
          )}
          {earlier && (
            <p data-thread-played className="text-sm">
              {playedLine(at, last, moved)}
            </p>
          )}
        </div>
      )}
      {failure !== null && (
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      )}
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          pending={pending}
          disabled={threads === null || problem !== null}
          focusableWhenDisabled
          hint={problem ?? "Starts the threads. You stay in this branch."}
          onClick={() => void start()}
        >
          Start
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** A message's action: at this message. */
export function StartThreadsHereDialog({ session, entry, closeDialog }: MessageActionProps) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const newest = view.newer === null ? view.entries.at(-1) : undefined
  return (
    <StartThreadsDialog
      session={session}
      entry={entry}
      last={newest ? positionOf(newest) : null}
      onClose={closeDialog}
    />
  )
}

/** The ⋯ menu's: at the newest message, read when the window shown doesn't reach it. */
export function StartThreadsCommandDialog({ context, onClose }: ChatCommandDialogProps) {
  const { session, view } = context
  const loaded = view.newer === null ? view.entries.at(-1) : undefined
  const [newest, setNewest] = useState<PathEntry | null>(loaded ?? null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (newest !== null) return
    let live = true
    void session
      .call((client) =>
        client("ReadPath", {
          chatId: session.id,
          forkId: shownForkOf(view),
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })
      )
      .then((result) => {
        if (!live) return
        if (!result.ok) return setFailure(result.error.message)
        const entry = result.value.entries.at(-1)
        if (entry) setNewest(entry)
        else setFailure("This branch has no messages yet.")
      })
    return () => {
      live = false
    }
    // Read once, as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (newest === null)
    return failure === null ? null : (
      <Dialog open onOpenChange={(open) => !open && onClose()} title="Start parallel threads">
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
      </Dialog>
    )
  return <StartThreadsDialog session={session} entry={newest} last={positionOf(newest)} onClose={onClose} />
}
