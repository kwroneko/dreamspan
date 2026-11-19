// Library and header creation share the same named-document dialog.
import type { LibraryRef } from "@dreamspan/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { Effect } from "effect"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"

type NewDocumentKind = "lorebook" | "note"

export function NewDocumentDialog({
  kind,
  open,
  onOpenChange,
  onCreated
}: {
  kind: NewDocumentKind
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (ref: LibraryRef) => Promise<void | boolean> | void | boolean
}) {
  const action = useAction()
  const [name, setName] = useState("")
  const [created, setCreated] = useState<LibraryRef | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName("")
      setCreated(null)
      setFinishError(null)
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || action.pending || finishing) return
    const result = created
      ? { ok: true as const, value: created }
      : await action.run(
          (client) =>
            Effect.gen(function* () {
              if (kind === "lorebook") return yield* client("CreateLorebook", { label: name.trim() })
              return yield* client("CreateSharedNote", { title: name.trim(), content: "" })
            }),
          ["library"]
        )
    if (result.ok) {
      setCreated(result.value)
      setFinishing(true)
      const finished = await onCreated(result.value)
      setFinishing(false)
      if (finished === false) setFinishError(`The ${kind} was created, but couldn't be attached. Retry to attach it.`)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`New ${kind}`}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            disabled={created !== null}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={200}
            required
          />
        </Field>
        <ErrorAlert error={action.error} />
        {finishError && (
          <p role="alert" className="text-sm text-danger">
            {finishError}
          </p>
        )}
        <DialogActions>
          <Button hint="Closes this dialog." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            pending={action.pending || finishing}
            disabled={!name.trim()}
            hint={`Creates an empty ${kind} and opens its editor.`}
          >
            Create
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

export function NewDocumentButton({ kind }: { kind: NewDocumentKind }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  return (
    <>
      <Button hint={`Opens a form to create a ${kind}.`} onClick={() => setOpen(true)}>
        New {kind}
      </Button>
      <NewDocumentDialog
        kind={kind}
        open={open}
        onOpenChange={setOpen}
        onCreated={(ref) => {
          setOpen(false)
          void navigate({ to: "/library/$refId", params: { refId: ref.id } })
        }}
      />
    </>
  )
}
