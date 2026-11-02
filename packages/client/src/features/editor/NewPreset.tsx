import type { LibraryRef } from "@rp/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"

/** What "New preset" starts from, said beside each place that offers it. */
export const NEW_PRESET_HINT = "A new prompt preset, starting as a copy of the built-in default"

/** "New preset", or "New preset 2" when that name is taken. */
export const newPresetName = (taken: ReadonlyArray<string>) => {
  const names = new Set(taken)
  if (!names.has("New preset")) return "New preset"
  let n = 2
  while (names.has(`New preset ${n}`)) n++
  return `New preset ${n}`
}

/**
 * Names a new prompt preset (the built-in default's prompts and settings) and creates it.
 * `onCreated` says where it goes next: its editor, or chosen for the next reply as well.
 */
export function NewPresetDialog({
  open,
  onOpenChange,
  name,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The name it suggests. */
  name: string
  onCreated: (ref: LibraryRef) => Promise<void> | void
}) {
  const action = useAction()
  const [label, setLabel] = useState(name)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setLabel(name)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = await action.run((client) => client("CreatePreset", { label: label.trim() }), ["library"])
    if (result.ok) {
      onOpenChange(false)
      await onCreated(result.value)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New prompt preset"
      description="Start with the built-in preset’s prompts and settings. Character cards can replace its prompts only if you allow it."
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} maxLength={200} required />
        </Field>
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" pending={action.pending} disabled={!label.trim()}>
            Create
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

export function NewPresetButton() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label={`${NEW_PRESET_HINT}, opened in its editor`}>
        <Button onClick={() => setOpen(true)}>New prompt preset</Button>
      </Tooltip>
      <NewPresetDialog
        open={open}
        onOpenChange={setOpen}
        name=""
        onCreated={(ref) => void navigate({ to: "/library/$refId", params: { refId: ref.id } })}
      />
    </>
  )
}
