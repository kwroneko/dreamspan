// Selecting several messages to delete together (job msgactions1; ST-COMPARISON item 24). "Select
// messages" on a message's menu starts it with that message ticked; every message then shows a
// tick before its portrait, and a bar above the composer counts them and offers Select range,
// Cancel, Hide from the model / Show to the model (job selecthide1) and Delete. Delete confirms,
// then deletes them in this branch as one change, one toast, one Undo, as Delete message would
// each; Hide and Show act at once, as the message menu's do, also as one change with one Undo.
import type { BinItem } from "@dreamspan/shared/bin.ts"
import type { ForkId, PathEntry, SlotId } from "@dreamspan/shared/chat.ts"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "../../../ui/Button.tsx"
import { RowTick } from "../../../ui/Choice.tsx"
import { ConfirmDialog } from "../../../ui/Dialog.tsx"
import { showToast } from "../../../ui/Toast.tsx"
import { useDeletedManyToast } from "../../bin/deleted.ts"
import { messageActions, viewOf } from "../messageActions.tsx"
import { chatComposerNotes, messageSelect } from "../presentation.tsx"
import type { ChatSession, ChatView } from "../session.ts"
import { orderedOf, selectionOf, type Ticked, untickable } from "./store.ts"

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** A message's tick: 0 not picking, 1 shown unticked, 2 ticked. Rows re-render only when theirs changes. */
const useTick = (session: ChatSession, slotId: SlotId) => {
  const store = selectionOf(session)
  return useSyncExternalStore(store.subscribe, () => {
    const state = store.snapshot()
    return state.active ? (state.ticked.has(slotId) ? 2 : 1) : 0
  })
}

function MessageTick({ entry, session }: { entry: PathEntry; session: ChatSession }) {
  const tick = useTick(session, entry.slotId)
  if (tick === 0) return null
  const why = untickable(entry)
  return (
    <RowTick
      checked={tick === 2}
      disabled={why !== null}
      label="Select this message"
      hint={why ?? "Selects this message to act on with the others. Shift-click selects every message up to it."}
      onToggle={(checked, shift) => selectionOf(session).toggle(entry, checked, shift)}
      // Compact rows have less room above the portrait: the tick keeps the row's own inset.
      className="-mt-0.5 compact:mt-0"
    />
  )
}

/** What the confirmation says goes, and stays. */
const describe = (ticked: ReadonlyArray<Ticked>) => {
  const versions = ticked.reduce((sum, t) => sum + t.versions, 0)
  const copied = ticked.filter((t) => t.copies.length > 0).length
  const what =
    versions > ticked.length
      ? `${ticked.length === 1 ? "It moves" : "They move"} to the bin with all ${plural(versions, "swipe", "swipes")}.`
      : `${ticked.length === 1 ? "It moves" : "They move"} to the bin.`
  return [
    what,
    "Only this branch changes: other branches that have them keep them.",
    copied > 0 &&
      `${copied === ticked.length && copied > 1 ? "All of them were" : copied === 1 && ticked.length === 1 ? "It was" : `${copied.toLocaleString()} of them were`} sent to other threads too; the copies there stay.`,
    "Undo, or the bin, puts them back."
  ]
    .filter(Boolean)
    .join(" ")
}

function SelectionBar({ session }: { view: ChatView; session: ChatSession }) {
  const store = selectionOf(session)
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const deleted = useDeletedManyToast()
  useEffect(() => {
    const unsubscribe = session.subscribe(() => store.reconcile())
    return () => {
      unsubscribe()
      store.stop()
    }
  }, [session, store])
  useEffect(
    () =>
      store.subscribe(() => {
        if (!store.snapshot().active) setConfirming(false)
      }),
    [store]
  )
  useEffect(() => {
    if (!state.active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirming && !event.defaultPrevented) store.stop()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [state.active, confirming, store])
  if (!state.active) return null
  const count = state.ticked.size
  const forkId = state.forkId
  const remove = async (fork: ForkId, ticked: ReadonlyArray<Ticked>) => {
    setPending(true)
    const result = await session.deleteMessages(
      fork,
      ticked.map((t) => t.slotId)
    )
    setPending(false)
    setConfirming(false)
    if (!result.ok) {
      if (result.error.tag === "NotFound") store.stop()
      showToast({
        title: "Nothing was deleted",
        description:
          result.error.tag === "NotFound"
            ? "Some of these messages changed or went since. Select them again."
            : result.error.message
      })
      return
    }
    store.stop()
    const copies = ticked.flatMap((t) => t.copies)
    deleted(
      [result.value],
      copies.length === 0
        ? []
        : [
            {
              label: copies.length === 1 ? "Delete the copy too" : `Delete the ${copies.length} copies too`,
              hint: "Moves the copies of these messages in other threads to the bin as well.",
              onClick: () => void deleteCopies(copies)
            }
          ]
    )
  }
  const deleteCopies = async (copies: ReadonlyArray<{ readonly slotId: SlotId; readonly forkId: ForkId }>) => {
    const byFork = new Map<ForkId, Array<SlotId>>()
    for (const copy of copies) byFork.set(copy.forkId, [...(byFork.get(copy.forkId) ?? []), copy.slotId])
    const groups: Array<ReadonlyArray<BinItem>> = []
    let failed = 0
    for (const [fork, slotIds] of byFork) {
      const result = await session.deleteMessages(fork, slotIds)
      if (result.ok) {
        if (result.value.length > 0) groups.push(result.value)
      } else failed += slotIds.length
    }
    if (groups.length > 0) deleted(groups)
    if (failed > 0)
      showToast({
        title: `${plural(failed, "copy wasn't", "copies weren't")} deleted`,
        description: "They changed or went since. Delete them in their threads."
      })
  }
  /** Hides the ticked messages from the model, or shows them again, as one change with one Undo. */
  const setHidden = async (fork: ForkId, ticked: ReadonlyArray<Ticked>, hidden: boolean) => {
    const targets = ticked.filter((t) => t.hidden !== hidden).map((t) => t.slotId)
    if (targets.length === 0) return
    setPending(true)
    const result = await session.setMessagesHidden(fork, targets, hidden)
    setPending(false)
    if (!result.ok) {
      if (result.error.tag === "NotFound") store.stop()
      showToast({
        title: "Nothing changed",
        description:
          result.error.tag === "NotFound"
            ? "Some of these messages changed or went since. Select them again."
            : result.error.message
      })
      return
    }
    store.stop()
    const changed = result.value.changed
    if (changed.length === 0) return
    showToast({
      title: `${plural(changed.length, "message", "messages")} ${hidden ? "hidden from the model" : "shown to the model again"}.`,
      timeout: 10_000,
      actions: [
        {
          label: "Undo",
          hint: hidden ? "Sends them to the model again." : "Hides them from the model again.",
          onClick: () =>
            void session.setMessagesHidden(fork, changed, !hidden).then((undo) => {
              if (!undo.ok) showToast({ title: "Couldn't undo", description: undo.error.message })
            })
        }
      ]
    })
  }
  const ordered = orderedOf(state.ticked)
  const anyShown = ordered.some((t) => !t.hidden)
  const anyHidden = ordered.some((t) => t.hidden)
  return (
    <div className="chat-column pb-2">
      <div
        role="region"
        aria-label="Selected messages"
        data-selection-bar
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
      >
        <span role="status" className="mr-auto shrink-0 text-sm whitespace-nowrap">
          {count === 0 ? "None selected" : `${plural(count, "message", "messages")} selected`}
        </span>
        <Button
          variant="ghost"
          className="h-8 px-2"
          aria-pressed={state.range}
          disabled={state.anchor === null}
          hint={
            state.range
              ? "The next message you tick selects every message from the last one ticked to it."
              : "Then tick a message: every message from the last one ticked to it is selected. Shift-click does the same."
          }
          onClick={() => store.setRange(!state.range)}
        >
          {state.range ? "Tick the range’s end" : "Select range"}
        </Button>
        <Button
          variant="ghost"
          className="h-8 px-2"
          hint="Stops selecting; nothing is deleted. Esc does the same."
          onClick={() => store.stop()}
        >
          Cancel
        </Button>
        {(anyShown || count === 0) && (
          <Button
            variant="ghost"
            className="h-8 px-2"
            disabled={count === 0 || forkId === null || pending}
            hint="Hides the selected messages from the model, in this branch only. They stay in the chat."
            onClick={() => forkId !== null && void setHidden(forkId, ordered, true)}
          >
            Hide from the model
          </Button>
        )}
        {anyHidden && (
          <Button
            variant="ghost"
            className="h-8 px-2"
            disabled={forkId === null || pending}
            hint="Sends the selected hidden messages to the model again, in this branch only."
            onClick={() => forkId !== null && void setHidden(forkId, ordered, false)}
          >
            Show to the model
          </Button>
        )}
        <Button
          variant="danger"
          className="h-8 px-3"
          disabled={count === 0 || forkId === null}
          hint="Asks first, then moves the selected messages to the bin, in this branch only."
          onClick={() => setConfirming(true)}
        >
          Delete…
        </Button>
        {state.notice !== null && <p className="w-full text-xs text-muted">{state.notice}</p>}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !pending && setConfirming(open)}
        title={count === 1 ? "Delete 1 message?" : `Delete ${count.toLocaleString()} messages?`}
        description={describe(ordered)}
        confirmLabel={count === 1 ? "Delete message" : `Delete ${count.toLocaleString()} messages`}
        confirmHint="Moves them to the bin in this branch, as one change you can undo."
        pending={pending}
        onConfirm={() => forkId !== null && void remove(forkId, ordered)}
      />
    </div>
  )
}

export const registerMessageSelection = () => [
  messageSelect.register({ id: "message.select-tick", source: import.meta.url, order: 0, component: MessageTick }),
  chatComposerNotes.register({ id: "chat.selection-bar", source: import.meta.url, order: 0, component: SelectionBar }),
  messageActions.register({
    id: "message.select",
    source: import.meta.url,
    onMerges: true,
    order: 105,
    group: "delete",
    describe: viewOf(({ entry, session }) => ({
      label: "Select messages",
      icon: "select",
      hint: "Ticks this message and shows a tick on every message, to delete, hide or show several together.",
      onSelect: () => selectionOf(session).start(entry)
    }))
  })
]
