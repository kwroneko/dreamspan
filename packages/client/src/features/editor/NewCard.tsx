// A card from scratch: its library label and its name, then the editor for the rest.
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    const result = await action.run((client) => client("CreateCard", { label: trimmed, name: trimmed }), ["library"])
    if (result.ok) void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New card</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New card"
        description="Its name is what chats call it, and its label in the library. You can change either later."
      >
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.currentTarget.value)} required />
          </Field>
          <ErrorAlert error={action.error} />
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" pending={action.pending} disabled={name.trim() === ""}>
              Create
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  )
}
