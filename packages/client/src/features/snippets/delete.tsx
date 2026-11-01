// Deleting a snippet (DESIGN §6.2): to the bin, with the usual toast and its Undo. A snippet
// other notes show is said so first, since those notes then send nothing until it's back.
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import type { SnippetWorkspace } from "./workspace.ts"

export function DeleteSnippet({ store, item }: { store: SnippetWorkspace; item: Snippet }) {
  const deleted = useDeletedToast()
  const [usedBy, setUsedBy] = useState(0)
  const [pending, setPending] = useState(false)
  const name = item.title || "Untitled snippet"
  const remove = async () => {
    setPending(true)
    const binned = await store.remove(item.ref.id)
    setPending(false)
    setUsedBy(0)
    if (binned) deleted(binned, () => void store.refresh())
  }
  return (
    <>
      <Button
        variant="ghost"
        className="h-8 px-2"
        aria-label={`Delete ${name}`}
        hint="Moves it to the bin, with Undo there and in the message that follows."
        disabled={pending}
        onClick={async () => {
          const used = await store.usedBy(item.ref.id)
          if (used > 0) setUsedBy(used)
          else void remove()
        }}
      >
        Delete
      </Button>
      <ConfirmDialog
        open={usedBy > 0}
        onOpenChange={(open) => !open && setUsedBy(0)}
        title={`Delete ${name}?`}
        description={`It's a shared note: ${usedBy} ${usedBy === 1 ? "note in a card or chat shows" : "notes in cards and chats show"} it. They send nothing until you restore it from the bin, or unlink them into copies.`}
        confirmLabel="Delete snippet"
        pending={pending}
        onConfirm={() => void remove()}
      />
    </>
  )
}
