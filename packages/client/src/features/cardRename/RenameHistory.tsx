// The question a change of a card's chat name asks (owner, 2026-11-01): where the name is
// confirmed (`atConfirm`, the name header), or after a fork or a swap renamed what a chat uses.
// "Replace <old> with <new> in the history: No / this chat / all N chats"; when the display
// name changed with no nickname (`display`), also keep the old name in chats or just change it.
import { useSession } from "../../session.ts"
import { keepPending, dropPending } from "./pending.ts"
import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { useCaller } from "../editor/caller.ts"
import type { CardSaved, CardSavedDone, RenameAnswer } from "../editor/cardSaved.ts"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { branchLabel } from "../chat/forks.ts"

type Target = NonNullable<CardSaved["current"]> & { label: string }

const wide = "h-auto! min-h-11 whitespace-normal! py-2! [overflow-wrap:anywhere]"

export function RenameHistory({ change, onDone }: { change: CardSaved; onDone: CardSavedDone }) {
  const user = useSession().user.id
  const call = useCaller()
  useEffect(() => {
    // Asked after a save, the name has changed already: an unanswered question can be resumed.
    // Asked on confirm, nothing has changed yet; only a failed replacement is kept.
    if (!change.atConfirm) keepPending(user, change)
  }, [user, change])
  const action = useAction()
  const [targets, setTargets] = useState<ReadonlyArray<Target> | null>(null)
  const [selected, setSelected] = useState(change.current?.forkId ?? null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [done, setDone] = useState<{ count: number; targets: ReadonlyArray<Target> } | null>(null)
  const failed = useRef(false)
  useEffect(() => {
    let active = true
    void call((client) =>
      Effect.gen(function* () {
        const found = yield* client("RenameHistoryTargets", { entityId: change.entityId })
        const result: Target[] = []
        for (const chatId of new Set(found.map((t) => t.chatId))) {
          const chat = yield* client("GetChat", { chatId })
          const forks = yield* client("ListForks", { chatId })
          for (const target of found.filter((t) => t.chatId === chatId)) {
            if (change.onlyThis && target.forkId !== change.current?.forkId) continue
            const fork = forks.find((f) => f.id === target.forkId)
            result.push({
              ...target,
              label: `${readableChatTitle(chat.title)} · ${fork ? branchLabel(fork) : "Branch"} · ${fork?.tipExcerpt || "Before the first message"}`
            })
          }
        }
        return result
      })
    ).then((result) => {
      if (!active) return
      if (result.ok) {
        setTargets(result.value)
        setError(null)
      } else setError(result.error.message)
    })
    return () => {
      active = false
    }
  }, [call, change, attempt])

  const finish = (answer: RenameAnswer, stay?: boolean) => onDone(stay, answer)
  /** Closing: on confirm, an unanswered question cancels the rename. */
  const close = () => finish(done ? "replaced" : failed.current ? "failed" : change.atConfirm ? "cancel" : "no")

  const replace = async (scope: "this" | "all") => {
    const chosen = scope === "all" ? (targets ?? []) : (targets?.filter((t) => t.forkId === selected) ?? [])
    const target = chosen[0]
    if (!target) return
    const result = await action.run(
      (client) =>
        client("RenameHistory", {
          entityId: change.entityId,
          oldName: change.oldName,
          newName: change.newName,
          scope,
          chatId: target.chatId,
          forkId: target.forkId
        }),
      ["chats"]
    )
    if (result.ok) {
      failed.current = false
      dropPending(user, change)
      setDone({ count: result.value, targets: chosen })
    } else if (change.atConfirm && !failed.current) {
      // The rename goes ahead; the replacement can be retried here, or resumed later.
      failed.current = true
      keepPending(user, { ...change, atConfirm: false, display: false })
    }
  }
  const all = targets?.length ?? 0
  const thisChat = !targets?.some((t) => t.forkId === selected)
  const replaceButtons = (yes: boolean) => (
    <>
      <Button
        className={wide}
        disabled={action.pending || thisChat}
        hint="Replaces the name in this chat's messages, swipes and summaries only; its other branches and other chats keep the old one."
        onClick={() => void replace("this")}
      >
        {yes ? "Yes, only in this chat." : "In this chat"}
      </Button>
      {!change.onlyThis && (
        <Button
          className={wide}
          disabled={action.pending || all === 0}
          hint="Replaces the name in the messages, swipes and summaries of every chat and branch that uses this card."
          onClick={() => void replace("all")}
        >
          {yes
            ? `Yes, in all ${targets?.length ?? "…"} ${all === 1 ? "chat" : "chats"} with ${change.oldName}`
            : `In all ${targets?.length ?? "…"} ${all === 1 ? "chat" : "chats"}`}
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.pending && close()}
      title={
        done
          ? "History replacement finished"
          : change.display
            ? `Rename ${change.oldName} to ${change.newName}?`
            : "Replace the name in past messages?"
      }
      description={
        change.display
          ? `“${change.oldName}” is also the name chats call them by: what should chats call them now?`
          : change.atConfirm
            ? `Chats will call them “${change.newName}” instead of “${change.oldName}”.`
            : `The card is saved. Its in-character name changed from “${change.oldName}” to “${change.newName}”.`
      }
    >
      {done ? (
        <>
          <p role="status" className="text-sm">
            {done.count
              ? `Replaced “${change.oldName}” with “${change.newName}” in ${done.count} ${done.count === 1 ? "chat" : "chats"}.`
              : "No matching text was found. Past messages are unchanged."}
          </p>
          {done.count > 0 && (
            <>
              <p className="text-sm text-muted">
                Inspect the resulting history diff or undo all or individual messages in each chat’s History edits.
              </p>
              <ul aria-label="History diffs and undo" className="flex flex-col gap-2">
                {done.targets.map((t) => (
                  <li key={t.forkId} className="min-w-0 [overflow-wrap:anywhere]">
                    <Link
                      to="/chats/$chatId"
                      params={{ chatId: t.chatId }}
                      search={{ fork: t.forkId, panel: "history" }}
                      className={`${buttonClass("ghost")} h-auto! whitespace-normal!`}
                      onClick={() => finish("replaced", true)}
                    >
                      History diff / undo: {t.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <>
          {!change.display && (
            <p className="text-sm [overflow-wrap:anywhere]">
              Replace “{change.oldName}” with “{change.newName}” in past messages?
            </p>
          )}
          <p className="text-sm text-muted">
            {change.atConfirm
              ? "Includes swipes and summaries. Branches count as separate chats. Closing this keeps the old name."
              : "Includes swipes and summaries. Branches count as separate chats. The name save is complete; a failed history replacement can be retried here."}
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <ErrorAlert error={action.error} />
          {error && (
            <Button hint="Reads the chats that use this card again." onClick={() => setAttempt((n) => n + 1)}>
              Retry reading chats
            </Button>
          )}
          {targets === null && !error && (
            <p role="status" className="text-sm text-muted">
              Reading chats…
            </p>
          )}
          {targets?.length === 0 && (
            <p role="status" className="text-sm text-muted">
              No chats currently use this card.
            </p>
          )}
          {!change.current && !!targets?.length && (
            <Field label="Chat for only this chat">
              <Select
                value={selected}
                onValueChange={setSelected}
                placeholder="Choose a chat"
                items={targets.map((t) => ({ value: t.forkId, label: t.label }))}
              />
            </Field>
          )}
          {change.current && targets !== null && (
            <p role="status" className="text-sm [overflow-wrap:anywhere]">
              Only this chat refers to:{" "}
              {targets.find((t) => t.forkId === change.current?.forkId)?.label ??
                "the original chat, which no longer uses this card"}
            </p>
          )}
          {change.display ? (
            <div className="flex flex-col gap-2">
              <Button
                className={wide}
                disabled={action.pending}
                hint={`“${change.oldName}” stays the name chats use, as its chat name; past messages stay as they are. The display name becomes “${change.newName}”.`}
                onClick={() => finish("keep")}
              >
                Keep “{change.oldName}” in chats
              </Button>
              <Button
                className={wide}
                disabled={action.pending}
                hint={`Chats call them “${change.newName}” from now on; past messages keep “${change.oldName}”.`}
                onClick={() => finish("plain")}
              >
                Just change it
              </Button>
              <p className="pt-1 text-sm font-medium">Rename everywhere: replace “{change.oldName}” in past messages</p>
              {replaceButtons(false)}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Button
                className={wide}
                disabled={action.pending}
                hint={`Renames from now on; past messages keep “${change.oldName}”.`}
                onClick={() => {
                  dropPending(user, change)
                  finish("no")
                }}
              >
                No. Past messages will keep “{change.oldName}”.
              </Button>
              {replaceButtons(true)}
              <p className="text-xs text-muted">
                “Only in this chat” doesn’t touch this chat’s other branches or any other chats.
              </p>
            </div>
          )}
        </>
      )}
    </Dialog>
  )
}
