// "Make this branch its own chat" (DESIGN §10.1, splitconfirm): every entry point asks here first.
// It says what splitting does and lets the new chat be titled, prefilled with the branch's own
// name, else the title of the chat it leaves. The title and split are one guarded write.
import { useCallback, useEffect, useState } from "react"
import type { ChatId, Fork, ForkId } from "@dreamspan/shared/chat.ts"
import { useAction } from "../../actions.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useChatPlaceKey } from "./chatPlace.ts"
import type { ChatCommandDialogProps } from "./commands.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { branchLabel, forksChanged } from "./forks.ts"
import { NameDialog } from "./NameDialog.tsx"
import { useSplitChats } from "./splitChats.ts"
import { requestSplitReveal } from "./splitReveal.ts"
import { cleanName } from "@dreamspan/shared/chatName.ts"

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
    const name = cleanName(title)
    const done = await action.run(
      (client) => client("SetSplitChat", { forkId, split: true, title: { name, expectedName: fork.name } }),
      ["chats", "pins"]
    )
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
                (client) =>
                  client("SetSplitChat", { forkId, split: false, title: { name: own, expectedName: name || null } }),
                ["chats", "pins"]
              )
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
      maxLength={200}
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
  const shown = context.view.forkId ?? context.view.chat?.currentForkId ?? null
  // The dialog is in the URL (a reload opens it again, its title as typed), and so is its branch:
  // once another branch shows (this one deleted, or another picked), it's done, rather than
  // asking about a branch no longer in view.
  const [target, setTarget] = usePlaceParam(useChatPlaceKey("splitFork"), "")
  const forkId = (target || shown) as ForkId | null
  useEffect(() => {
    if (target === "" && shown !== null) setTarget(shown, true)
  }, [target, shown, setTarget])
  const close = useCallback(() => {
    setTarget("", true)
    onClose()
  }, [setTarget, onClose])
  useEffect(() => {
    if (target !== "" && shown !== null && shown !== target) close()
  }, [target, shown, close])
  return forkId && (target === "" || target === shown) ? (
    <SplitChatDialog chatId={context.session.id} forkId={forkId} onClose={close} />
  ) : null
}
