// "Make this branch its own chat" (DESIGN §10.1, splitconfirm): every entry point asks here first.
// It says what splitting does and lets the new chat be titled, prefilled with the branch's own
// name, else the title of the chat it leaves. Confirming names the branch, then splits it off.
import { useEffect, useState } from "react"
import type { ChatId, Fork, ForkId } from "@rp/shared/chat.ts"
import { useAction } from "../../actions.tsx"
import type { ChatCommandDialogProps } from "./commands.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { branchLabel, forksChanged } from "./forks.ts"
import { NameDialog } from "./NameDialog.tsx"
import { useSplitChats } from "./splitChats.ts"
import { requestSplitReveal } from "./splitReveal.ts"

export function SplitChatDialog({
  chatId,
  forkId,
  onClose
}: {
  /** The physical chat holding the branch's history. */
  chatId: ChatId
  forkId: ForkId
  onClose: () => void
}) {
  const split = useSplitChats(chatId, forkId)
  const action = useAction()
  const reader = useAction()
  const [fork, setFork] = useState<Fork | null>(null)
  useEffect(() => {
    let live = true
    void reader
      .run((client) => client("ListForks", { chatId }))
      .then((result) => {
        if (live && result.ok) setFork(result.value.find((f) => f.id === forkId) ?? null)
      })
    return () => {
      live = false
    }
    // Read once per branch; `reader` is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, forkId])
  if (split === null || fork === null) return null
  const parent = split.group.title
  const own = fork.name ?? ""
  const save = async (title: string) => {
    const name = title.trim()
    if (name !== own) {
      const named = await action.run((client) => client("NameFork", { forkId, name }), ["chats"])
      if (!named.ok) return false
    }
    const done = await action.run((client) => client("SetSplitChat", { forkId, split: true }), ["chats", "pins"])
    if (!done.ok) return false
    forksChanged(chatId)
    requestSplitReveal(forkId, true)
    onClose()
    showToast({
      title: "Branch is now its own chat",
      actions: [
        {
          label: "Undo",
          hint: "Puts this chat back among its parent's branches.",
          onClick: () => {
            void (async () => {
              const undone = await action.run(
                (client) => client("SetSplitChat", { forkId, split: false }),
                ["chats", "pins"]
              )
              if (undone.ok && name !== own)
                await action.run((client) => client("NameFork", { forkId, name: own }), ["chats"])
              if (undone.ok) forksChanged(chatId)
              else showToast({ title: "Couldn't restore the branch", description: undone.error.message })
            })()
          }
        }
      ]
    })
    return true
  }
  return (
    <NameDialog
      draftTarget={`fork:${forkId}:split-title`}
      open
      onOpenChange={(open) => !open && !action.pending && onClose()}
      title="Make this branch its own chat?"
      summary={
        <>
          “{branchLabel(fork)}” and the branches made from it leave “{parent}” and become a separate chat in your Chats
          list, with its own branches. Nothing is copied or deleted: the new chat starts with the messages the two
          share, and each links to the other in the sidebar and where they part. Use it when a branch has grown into a
          story of its own.
        </>
      }
      label="Chat title"
      initial={own !== "" ? own : parent}
      description="Leave it empty to name the chat after the one it leaves, with the date."
      maxLength={100}
      saveLabel="Make its own chat"
      saveHint="Splits this branch off as a separate chat with this title."
      pending={action.pending}
      error={action.error}
      onSave={save}
    />
  )
}

/** The ⋯ menu's entry: the branch shown when it opened. */
export function SplitChatCommandDialog({ context, onClose }: ChatCommandDialogProps) {
  const [forkId] = useState(context.view.forkId ?? context.view.chat?.currentForkId ?? null)
  return forkId ? <SplitChatDialog chatId={context.session.id} forkId={forkId} onClose={onClose} /> : null
}
