// Browser copies survive unavailable targets and expired sessions. The user can inspect,
// retry, or explicitly delete each one; account partitioning limits this view to its owner.
import { useSession } from "../../session.ts"
import { useEffect, useState } from "react"
import { Icon } from "../../ui/Icon.tsx"
import { Button } from "../../ui/Button.tsx"
import { textareaResize } from "../../ui/HeightGrip.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { copiesOfUser, type Copy, dropCopy, flushCopies, pendingOf, subscribeCopies } from "./backup.ts"
import { adoptTypedBackups } from "./typedBackup.ts"

import { dropTypedBackup } from "./typedBackup.ts"

/**
 * How old a copy must be before the sidebar warning counts it. Normal typing keeps a copy
 * only through its save delay and request; an older one didn't arrive (a failed save, a
 * missing target, an expired session or a stalled request).
 */
const STUCK_MS = 10_000

export function RecoveryNotice() {
  return (
    <p role="status">
      Text that could not return to its original draft is kept in{" "}
      <a href="/bin?section=recovered" className="underline">
        the bin, under Recovered text
      </a>
      . After logging out, log in to the same account to find this text.
    </p>
  )
}

export function BrowserRecovery({
  userId,
  initiallyOpen = false,
  initiallyRecovered = 0,
  warning = false
}: {
  userId: string
  initiallyOpen?: boolean
  initiallyRecovered?: number
  warning?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const [copies, setCopies] = useState<ReadonlyArray<Copy>>([])
  const [deleting, setDeleting] = useState<Copy | null>(null)
  const [pending, setPending] = useState(false)
  const [recovered, setRecovered] = useState(initiallyRecovered)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let active = true
    let version = 0
    const refresh = () => {
      const current = ++version
      void adoptTypedBackups(userId)
        .then(() => copiesOfUser(userId))
        .then((next) => {
          if (active && current === version) {
            setNow(Date.now())
            setCopies(next)
          }
        })
    }
    const unsubscribe = subscribeCopies(refresh)
    refresh()
    return () => {
      active = false
      unsubscribe()
    }
  }, [userId])
  // The warning counts only stuck copies, re-checking when the youngest one comes of age.
  const stuck = copies.filter((copy) => now - copy.at >= STUCK_MS)
  const nextStuck = copies.reduce(
    (soonest, copy) => (now - copy.at < STUCK_MS ? Math.min(soonest, copy.at + STUCK_MS) : soonest),
    Infinity
  )
  useEffect(() => {
    if (!warning || nextStuck === Infinity) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextStuck - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [warning, nextStuck])
  const read = async () => setCopies(await copiesOfUser(userId))
  return (
    <>
      {(!warning || stuck.length > 0) && (
        <Button
          variant="ghost"
          className={
            warning
              ? "mb-2 w-full border border-warning/50 bg-warning/5 text-warning hover:bg-warning/10 hover:text-warning"
              : ""
          }
          hint="Text typed in this browser that hasn't reached the server yet."
          onClick={async () => {
            await read()
            setOpen(true)
          }}
        >
          {warning && <Icon name="alert" />}
          {warning ? `${stuck.length} unsaved ${stuck.length === 1 ? "text" : "texts"}` : "Unsaved text"}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) void read()
        }}
        title="Text kept in this browser"
        description="These copies stay until saved or until you explicitly delete them. You can copy the text out here, or retry saving it."
      >
        {recovered > 0 && <RecoveryNotice />}
        {copies.length === 0 ? (
          <p>No unsaved browser copies.</p>
        ) : (
          copies.map((copy) => {
            const save = pendingOf(copy)
            const first = save?.kind === "pendingChat" ? save.payload : null
            return (
              <div key={copy.key} className="flex flex-col gap-2">
                {first !== null ? (
                  <p className="text-sm text-muted">
                    {first.chatId === undefined ? "First message to" : "Next message in"} {first.name}, not sent yet:{" "}
                    <a
                      href={
                        first.chatId !== undefined
                          ? `/chats/${encodeURIComponent(first.chatId)}`
                          : first.groupChatId === undefined
                            ? `/cards/${encodeURIComponent(first.entityId)}/chat`
                            : `/groups/${encodeURIComponent(first.groupChatId)}/new`
                      }
                      className="underline"
                    >
                      open the new chat
                    </a>
                  </p>
                ) : (
                  <p className="text-sm text-muted">
                    {copy.refId} · {copy.field}
                  </p>
                )}
                <textarea
                  aria-label="Recovery text"
                  readOnly
                  value={copy.content}
                  {...textareaResize}
                  className="max-h-64 min-h-24 resize-y rounded-md border border-border bg-surface p-2"
                />
                <Button hint="Deletes this browser’s saved copy." variant="danger" onClick={() => setDeleting(copy)}>
                  Delete this copy
                </Button>
              </div>
            )
          })
        )}
        <DialogActions>
          <Button hint="Closes this dialog and keeps the saved copies." onClick={() => setOpen(false)}>
            Keep copies
          </Button>
          <Button
            pending={pending}
            hint="Sends each copy to the server again. Those that arrive leave this list."
            onClick={async () => {
              setPending(true)
              const result = await flushCopies(userId)
              setCopies(result.copies)
              setRecovered((count) => count + result.recovered)
              setPending(false)
            }}
          >
            Retry saving
          </Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title="Delete this browser copy?"
        description="This permanently deletes the copy shown here. Save or copy out any text you want to keep first."
        confirmLabel="Delete copy"
        onConfirm={async () => {
          if (deleting === null) return
          dropTypedBackup(deleting)
          await dropCopy(deleting)
          setDeleting(null)
          await read()
        }}
      />
    </>
  )
}

/** The shell's conditional recovery notice; the dialog remains mounted when the last copy leaves. */
export function BrowserRecoveryWarning() {
  return <BrowserRecovery userId={useSession().user.id} warning />
}
