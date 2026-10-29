import { useSession } from "../../session.ts"
import { keepPending, dropPending } from "./pending.ts"
import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { useCaller } from "../editor/caller.ts"
import type { CardSaved } from "../editor/cardSaved.ts"
import { readableChatTitle } from "../chat/chatTitle.ts"

type Target = NonNullable<CardSaved["current"]> & { label: string }

export function RenameHistory({ change, onDone }: { change: CardSaved; onDone: (stay?: boolean) => void }) {
  const user = useSession().user.id
  const call = useCaller()
  useEffect(() => {
    keepPending(user, change)
  }, [user, change])
  const action = useAction()
  const [targets, setTargets] = useState<ReadonlyArray<Target> | null>(null)
  const [selected, setSelected] = useState(change.current?.forkId ?? null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [done, setDone] = useState<{ count: number; targets: ReadonlyArray<Target> } | null>(null)
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
              label: `${readableChatTitle(chat.title)} · ${fork?.name || (fork?.current ? "Current fork" : `Fork ${forks.findIndex((f) => f.id === target.forkId) + 1}`)} · ${fork?.tipExcerpt || "Before the first message"}`
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
      dropPending(user, change)
      setDone({ count: result.value, targets: chosen })
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.pending && onDone()}
      title={done ? "History replacement finished" : "Replace the name in past messages?"}
      description={`The card is saved. Its in-character name changed from “${change.oldName}” to “${change.newName}”.`}
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
                      onClick={() => onDone(true)}
                    >
                      History diff / undo: {t.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          <DialogActions>
            <Button onClick={() => onDone()}>Done</Button>
          </DialogActions>
        </>
      ) : (
        <>
          <p className="text-sm [overflow-wrap:anywhere]">
            Replace “{change.oldName}” with “{change.newName}” in past messages?
          </p>
          <p className="text-sm text-muted">
            Includes swipes and summaries. Forks count as separate chats. The name save is complete; a failed history
            replacement can be retried here.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <ErrorAlert error={action.error} />
          {error && <Button onClick={() => setAttempt((n) => n + 1)}>Retry reading chats</Button>}
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
          <div className="flex flex-col gap-2">
            <Button
              className="h-auto! min-h-11 whitespace-normal! py-2! [overflow-wrap:anywhere]"
              disabled={action.pending}
              onClick={() => {
                dropPending(user, change)
                onDone()
              }}
            >
              No. Past messages will keep “{change.oldName}”.
            </Button>
            <Button
              className="h-auto! min-h-11 whitespace-normal! py-2! [overflow-wrap:anywhere]"
              disabled={action.pending || !targets?.some((t) => t.forkId === selected)}
              onClick={() => void replace("this")}
            >
              Yes, only in this chat.
            </Button>
            <p className="text-xs text-muted">Does not touch any forks of this chat or any other chats.</p>
            {!change.onlyThis && (
              <Button
                className="h-auto! min-h-11 whitespace-normal! py-2! [overflow-wrap:anywhere]"
                disabled={action.pending || !targets?.length}
                onClick={() => void replace("all")}
              >
                Yes, in all {targets?.length ?? "…"} chats with {change.oldName}
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog>
  )
}
