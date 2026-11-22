import type { LibraryRef } from "@dreamspan/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useDurableText, useOpenPlace } from "./durable.tsx"

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
  place,
  open,
  onOpenChange,
  name,
  onCreated
}: {
  /** Where it's opened from, unique to it: the key the typed name is kept under. */
  place: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The name it suggests. */
  name: string
  onCreated: (ref: LibraryRef) => Promise<void> | void
}) {
  // The name is read and kept only while the dialog is open.
  if (!open) return null
  return <NewPresetForm place={place} onOpenChange={onOpenChange} name={name} onCreated={onCreated} />
}

function NewPresetForm({
  place,
  onOpenChange,
  name,
  onCreated
}: {
  place: string
  onOpenChange: (open: boolean) => void
  name: string
  onCreated: (ref: LibraryRef) => Promise<void> | void
}) {
  const action = useAction()
  const durable = useDurableText(`new-preset:${place}`, "Name", name)
  const label = durable.text
  const close = () => {
    void durable.discard()
    onOpenChange(false)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    let created: LibraryRef | null = null
    await durable.commit(async (text) => {
      const result = await action.run((client) => client("CreatePreset", { label: text.trim() }), ["library"])
      if (result.ok) created = result.value
      return result.ok
    })
    if (created) {
      onOpenChange(false)
      await onCreated(created)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()} title="New prompt preset">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={label}
            readOnly={!durable.ready}
            onChange={(event) => durable.setText(event.currentTarget.value)}
            maxLength={200}
            required
          />
        </Field>
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={close}>
            Cancel
          </Button>
          <Button
            hint="Creates the prompt preset."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={!label.trim()}
          >
            Create
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

export function NewPresetButton() {
  const navigate = useNavigate()
  const [open, setOpen] = useOpenPlace("new-preset")
  return (
    <>
      <Tooltip label={`${NEW_PRESET_HINT}, opened in its editor`}>
        <Button onClick={() => setOpen(true)}>New prompt preset</Button>
      </Tooltip>
      <NewPresetDialog
        place="library"
        open={open}
        onOpenChange={setOpen}
        name=""
        onCreated={(ref) => void navigate({ to: "/library/$refId", params: { refId: ref.id } })}
      />
    </>
  )
}
