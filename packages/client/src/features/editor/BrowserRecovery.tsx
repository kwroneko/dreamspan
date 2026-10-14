// Browser copies survive unavailable targets and expired sessions. The user can inspect,
// retry, or explicitly delete each one; account partitioning limits this view to its owner.
import { useEffect, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { copiesOfUser, type Copy, dropCopy, flushCopies, pendingOf } from "./backup.ts"

export function RecoveryNotice() {
  return (
    <p role="status">
      Some text could not return to its original draft and was moved to{" "}
      <a href="/bin?section=recovered" className="underline">
        recovered texts in the bin
      </a>
      . After logging out, log in to the same account to find it.
    </p>
  )
}

export function BrowserRecovery({
  userId,
  initiallyOpen = false,
  initiallyRecovered = 0
}: {
  userId: string
  initiallyOpen?: boolean
  initiallyRecovered?: number
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const [copies, setCopies] = useState<ReadonlyArray<Copy>>([])
  const [deleting, setDeleting] = useState<Copy | null>(null)
  const [pending, setPending] = useState(false)
  const [recovered, setRecovered] = useState(initiallyRecovered)
  useEffect(() => {
    if (initiallyOpen) void copiesOfUser(userId).then(setCopies)
  }, [initiallyOpen, userId])
  const read = async () => setCopies(await copiesOfUser(userId))
  return (
    <>
      <Button
        variant="ghost"
        onClick={async () => {
          await read()
          setOpen(true)
        }}
      >
        Browser recovery
      </Button>
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
                    First message to {first.name}, not sent yet:{" "}
                    <a
                      href={
                        first.groupChatId === undefined
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
                  className="max-h-64 min-h-24 rounded-md border border-border bg-surface p-2"
                />
                <Button variant="danger" onClick={() => setDeleting(copy)}>
                  Delete this copy
                </Button>
              </div>
            )
          })
        )}
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Keep copies</Button>
          <Button
            pending={pending}
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
          await dropCopy(deleting)
          setDeleting(null)
          await read()
        }}
      />
    </>
  )
}
