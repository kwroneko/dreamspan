// A change row's action (spec/WORKSHOP-CARDS.md §7.2, §8): Revert for an edit, Undo for an item
// the turn made (to the bin), each undoing the turn's changes of that item newest first; once done,
// "Reverted" or "Undone", muted. The change view's header shows the same.
import { useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { type ItemChange, itemUndone } from "./changeRows.ts"
import { EFFECTS_KEY, effectKey, undoable } from "./effects.ts"

const actionLabel = (item: ItemChange) => (item.created ? "Undo" : "Revert")

const actionHint = (item: ItemChange) =>
  item.created
    ? `Moves ${item.label} to the bin, with what this reply wrote in it.`
    : `Puts ${item.label} back as it was before this reply, as a new revision.`

export function ItemChangeAction({ item }: { item: ItemChange }) {
  const action = useAction()
  if (itemUndone(item))
    return (
      <Tooltip
        label={
          item.created ? `${item.label} is in the bin.` : `${item.label} was put back as it was before this reply.`
        }
      >
        <span
          tabIndex={0}
          data-change-state
          className="shrink-0 rounded-sm px-2 text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {item.created ? "Undone" : "Reverted"}
        </span>
      </Tooltip>
    )
  const pending = item.effects.filter(undoable)
  if (pending.length === 0) return null
  const run = async () => {
    // Newest first, as the turn made them: each undo needs the item as the next one left it.
    for (const effect of pending) {
      const result = await action.run(
        (client) => client("UndoRolloutEffect", effectKey(effect)),
        [EFFECTS_KEY, "library", "chats", "chat-lists", "bin"]
      )
      if (!result.ok) return
    }
  }
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Button
        variant="ghost"
        className="h-7 px-2 text-xs"
        pending={action.pending}
        hint={actionHint(item)}
        onClick={() => void run()}
        data-change-action
      >
        {actionLabel(item)}
      </Button>
      {action.error && (
        <span role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
          Not {item.created ? "undone" : "reverted"}: {action.error.message}
        </span>
      )}
    </span>
  )
}
