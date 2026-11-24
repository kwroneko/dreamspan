// A change row's action (spec/WORKSHOP-CARDS.md §7.2, §8.1): Revert for an edit, taking the
// turn's change back field by field on the item as it is now, as a new revision (later edits
// stay); Undo for an item the turn made, to the bin, asking first when it changed since or a chat
// uses it. Done, it says "Reverted" (with Redo) or "Undone", muted. A revert that conflicts writes
// nothing and opens the change view to choose. The change view's header shows the same.
import type { ReversalOutcome } from "@dreamspan/shared/workshopApi.ts"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { openNearProps } from "../workbench/kinds.ts"
import {
  type ChangeReply,
  changedSince,
  changeViewHref,
  type ItemChange,
  itemReverted,
  itemUndone,
  liveKeys,
  standingReverts
} from "./changeRows.ts"
import { EFFECTS_KEY, effectKey, undoable } from "./effects.ts"

/** What a library change touches: the lists to read again after it. */
export const CHANGE_KEYS = [EFFECTS_KEY, "library", "chats", "chat-lists", "bin"]

/** "Reverted the assistant's change of 14:02": the new revision's message. */
export const revertMessage = (item: ItemChange) => {
  const at = item.effects.at(0)?.createdAt
  const time = at ? new Date(at).toLocaleTimeString([], { timeStyle: "short" }) : null
  return time ? `Reverted the assistant's change of ${time}` : "Reverted the assistant's change"
}

const actionHint = (item: ItemChange) =>
  item.created
    ? `Moves ${item.label} to the bin, with what this reply wrote in it.`
    : item.file
      ? "Takes this reply's change out of the card file, keeping later edits. The file as it is now is kept as an earlier version."
      : `Takes this reply's change out of ${item.label}, keeping later edits, as a new revision.`

const muted = "shrink-0 rounded-sm px-2 text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"

/** "Ove Brekke was changed since and is in 1 chat." */
const askText = (name: string, changed: boolean, chats: number) => {
  const inChats = chats === 1 ? "is in 1 chat" : `is in ${chats} chats`
  if (changed && chats > 0) return `${name} was changed since and ${inChats}.`
  return changed ? `${name} was changed since.` : `${name} ${inChats}.`
}

export function ItemChangeAction({
  item,
  reply,
  onConflicts
}: {
  item: ItemChange
  /** The reply, to open the change view when a revert conflicts. */
  reply?: ChangeReply
  /** In the change view: show the conflicts there instead of opening it. */
  onConflicts?: (outcome: ReversalOutcome) => void
}) {
  const action = useAction()
  const [conflicted, setConflicted] = useState(false)
  const [ask, setAsk] = useState<string | null>(null)
  const resolve = useRef<HTMLAnchorElement>(null)
  // A revert that conflicts opens the change view where the row's count would.
  useEffect(() => {
    if (conflicted) resolve.current?.click()
  }, [conflicted])
  const reverted = itemReverted(item)
  if (itemUndone(item) || reverted) {
    const reverts = standingReverts(item)
    const redo = async () => {
      for (const reversalId of reverts) {
        const result = await action.run((client) => client("RedoChange", { reversalId }), CHANGE_KEYS)
        if (!result.ok || result.value.conflicts.length > 0) return
      }
    }
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Tooltip
          label={
            item.created
              ? `${item.label} is in the bin.`
              : item.file
                ? "This reply's change was taken out of the card file."
                : `This reply's change was taken out of ${item.label}.`
          }
        >
          <span tabIndex={0} data-change-state className={muted}>
            {item.created ? "Undone" : "Reverted"}
          </span>
        </Tooltip>
        {reverted && reverts.length > 0 && (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            pending={action.pending}
            hint="Puts this reply's change back, keeping edits made since, as a new revision."
            onClick={() => void redo()}
            data-change-redo
          >
            Redo
          </Button>
        )}
        {action.error && (
          <span role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
            Not redone: {action.error.message}
          </span>
        )}
      </span>
    )
  }
  const pending = item.effects.filter(undoable)
  if (pending.length === 0) return null
  const undoAll = async (binAnyway: boolean) => {
    // Newest first, as the turn made them: each undo needs the item as the next one left it.
    // Asked, the made item goes to the bin as it is now.
    const order = binAnyway ? pending.filter((e) => e.kind === "library.create") : pending
    for (const effect of order) {
      const result = await action.run(
        (client) => client("UndoRolloutEffect", { ...effectKey(effect), ...(binAnyway ? { binAnyway } : {}) }),
        CHANGE_KEYS
      )
      if (!result.ok) return
    }
    setAsk(null)
  }
  const undo = async () => {
    // Changed since, or in a chat: ask first (spec/WORKSHOP-CARDS.md §8.1).
    const seen = await action.run(
      (client) =>
        Effect.all({
          revisions: client("ListRevisions", { refId: item.refId as never, limit: 50 }),
          editor: client("OpenEditor", { refId: item.refId as never })
        }),
      []
    )
    if (!seen.ok) return
    const changed = changedSince(seen.value.revisions, item.to) !== null
    const chats = seen.value.editor.usedByChats
    if (changed || chats > 0) setAsk(askText(item.label, changed, chats))
    else await undoAll(false)
  }
  const revert = async () => {
    setConflicted(false)
    const result = await action.run(
      (client) => client("RevertChange", { effects: liveKeys(item), message: revertMessage(item) }),
      CHANGE_KEYS
    )
    if (!result.ok || result.value.conflicts.length === 0) return
    if (onConflicts) onConflicts(result.value)
    else setConflicted(true)
  }
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Button
        variant="ghost"
        className="h-7 px-2 text-xs"
        pending={action.pending}
        hint={actionHint(item)}
        onClick={() => void (item.created ? undo() : revert())}
        data-change-action
      >
        {item.created ? "Undo" : "Revert"}
      </Button>
      {conflicted && reply && (
        <Tooltip label="Opens what changed, to choose for each field whether to keep it as it is now.">
          <a
            ref={resolve}
            href={`${changeViewHref(item, reply)}&resolve=1`}
            data-change-resolve
            className="rounded-sm text-xs text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            {...openNearProps(
              item.file ? "files.card-change" : "library.change",
              `/library/${encodeURIComponent(item.refId)}`
            )}
            {...linkMenuProps}
          >
            Changed since: choose what to keep
          </a>
        </Tooltip>
      )}
      {action.error && (
        <span role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
          Not {item.created ? "undone" : "reverted"}: {action.error.message}
        </span>
      )}
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(open) => !open && setAsk(null)}
        title={`Move ${item.label} to the bin?`}
        description={`${ask ?? ""} Move it to the bin anyway? You can restore it from the bin.`}
        confirmLabel="Move to the bin"
        confirmHint={`Moves ${item.label} to the bin as it is now.`}
        pending={action.pending}
        onConfirm={() => void undoAll(true)}
      />
    </span>
  )
}
