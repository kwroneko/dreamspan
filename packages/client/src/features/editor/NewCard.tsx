import { useCardNameCheck } from "./cardNameCheck.ts"
// A card from scratch: the three standard names, then the editor for the rest.
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"

export function NewCardButton() {
  const action = useAction()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [nickname, setNickname] = useState("")
  const [version, setVersion] = useState("")
  const clash = useCardNameCheck(name.trim(), version.trim())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (clash) return
    const trimmed = name.trim()
    const result = await action.run(
      (client) => client("CreateCard", { label: trimmed, name: trimmed, nickname, version: version.trim() }),
      ["library"]
    )
    if (result.ok) void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New card</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New card"
        description="These names are saved with the card and travel with its exported file."
      >
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field label="Display name">
            <Input value={name} onChange={(event) => setName(event.currentTarget.value)} required />
          </Field>
          <Field label="Name the model sees (leave empty to use the display name)">
            <Input value={nickname} onChange={(event) => setNickname(event.currentTarget.value)} />
          </Field>
          <Field label="Version (shown as subtitle)">
            <Input value={version} onChange={(event) => setVersion(event.currentTarget.value)} />
          </Field>
          {clash && (
            <p role="status" className="text-sm text-muted">
              {clash}
            </p>
          )}
          <ErrorAlert error={action.error} />
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              pending={action.pending}
              disabled={name.trim() === "" || clash !== null}
            >
              Create
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  )
}
