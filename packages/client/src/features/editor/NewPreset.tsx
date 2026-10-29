import { type FormEvent, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { usePresetWorkspace } from "./PresetWorkspace.tsx"

export function NewPresetButton() {
  const action = useAction()
  const workspace = usePresetWorkspace()
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState("")
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = await action.run((client) => client("CreatePreset", { label: label.trim() }), ["library"])
    if (result.ok) {
      setOpen(false)
      setLabel("")
      workspace?.open(result.value.id)
    }
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>New prompt preset</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New prompt preset"
        description="Start with an ordered set of prompts. Cards cannot replace its prompts unless you allow it."
      >
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} maxLength={200} required />
          </Field>
          <ErrorAlert error={action.error} />
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" pending={action.pending} disabled={!label.trim()}>
              Create
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  )
}
