import { useContext, useState } from "react"
import { RegistryContext } from "@effect/atom-react"
import { ErrorAlert, invalidateKeys, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import type { ChatCommandDialogProps } from "./commands.tsx"
import { useSplitChats } from "./splitChats.ts"
import { requestSplitReveal } from "./splitReveal.ts"

export function DeleteChatGroupDialog({ context, onClose }: ChatCommandDialogProps) {
  const { session, view, navigate } = context
  const [forkId] = useState(view.forkId ?? view.chat?.currentForkId ?? null)
  const split = useSplitChats(session.id, forkId)
  const action = useAction()
  const registry = useContext(RegistryContext)
  const deleted = useDeletedToast()
  const count = split?.forkIds.length ?? 0
  const remove = async () => {
    if (!split) return
    const result = await action.run(
      (client) =>
        client("DeleteChatGroup", {
          chatId: session.id,
          forkId: forkId!,
          expectedForkIds: split.forkIds
        }),
      ["chats", "pins", "bin"]
    )
    if (!result.ok) {
      if (result.error.tag === "BinChanged") invalidateKeys(registry, ["chats"])
      return
    }
    const { item, next } = result.value
    onClose()
    deleted(item, () => {
      requestSplitReveal(split.group.id)
      void navigate?.({
        to: "/chats/$chatId",
        params: { chatId: split.group.chatId },
        search: { fork: split.group.forkId }
      })
    })
    if (next) {
      requestSplitReveal(next.id)
      void navigate?.({ to: "/chats/$chatId", params: { chatId: next.chatId }, search: { fork: next.forkId } })
    } else void navigate?.({ to: "/" })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.pending && onClose()}
      title={`Delete “${split?.group.title ?? "this chat"}”?`}
      description={`Moves ${count} ${count === 1 ? "branch" : "branches"} to the bin. Split-off chats stay available.`}
    >
      <ErrorAlert error={action.error} />
      <DialogActions>
        <Button hint="Keeps this chat open." onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button
          variant="danger"
          hint={`Moves this chat's ${count} ${count === 1 ? "branch" : "branches"} to the bin.`}
          onClick={() => void remove()}
          pending={action.pending}
          disabled={!split}
        >
          Delete chat
        </Button>
      </DialogActions>
    </Dialog>
  )
}
