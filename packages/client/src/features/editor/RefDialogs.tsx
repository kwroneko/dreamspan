// Edit scope (DESIGN §4): making a named variant is one action, and the library label is
// the entry's name in the library, apart from the name chats use.
import type { LibraryRef } from "@rp/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { type EditorStore, useEditorState } from "./store.ts"

export function ForkDialog({ store, onClose }: { store: EditorStore; onClose: () => void }) {
  const state = useEditorState(store)
  const ref = state.snapshot!.ref
  const action = useAction()
  const navigate = useNavigate()
  const dirty = state.dirty > 0
  const [label, setLabel] = useState(`${ref.label} (variant)`)
  const [subtitle, setSubtitle] = useState("")
  const [moveDrafts, setMoveDrafts] = useState(dirty)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await store.flush()
    const result = await action.run(
      (client) => client("ForkVariant", { refId: ref.id, label: label.trim(), subtitle: subtitle.trim(), moveDrafts }),
      ["library"]
    )
    if (result.ok) void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Make a variant"
      description={`A named variant follows “${ref.label}”: its changes stay in the variant, and updates to “${ref.label}” still reach it.`}
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label="Library label">
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} required />
        </Field>
        <Field label="Subtitle (optional)" description="Tells variants of one character apart in the library.">
          <Input value={subtitle} onChange={(event) => setSubtitle(event.currentTarget.value)} />
        </Field>
        {dirty && (
          <Checkbox checked={moveDrafts} onCheckedChange={setMoveDrafts}>
            Take my unsaved changes to the variant
          </Checkbox>
        )}
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={action.pending} disabled={label.trim() === ""}>
            Make the variant
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

export function RenameDialog({
  store,
  onClose,
  onRenamed
}: {
  store: EditorStore
  onClose: () => void
  onRenamed: (ref: LibraryRef) => void
}) {
  const ref = useEditorState(store).snapshot!.ref
  const action = useAction()
  const [label, setLabel] = useState(ref.label)
  const [subtitle, setSubtitle] = useState(ref.subtitle)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = await action.run(
      (client) =>
        client("RenameRef", {
          refId: ref.id,
          label: label.trim(),
          subtitle: subtitle.trim(),
          expectedRowVersion: ref.rowVersion
        }),
      ["library"]
    )
    if (result.ok) onRenamed(result.value)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Rename in the library"
      description="Only the library shows this. The name chats use is the card's own Name field."
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label="Library label">
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} required />
        </Field>
        <Field label="Subtitle (optional)">
          <Input value={subtitle} onChange={(event) => setSubtitle(event.currentTarget.value)} />
        </Field>
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={action.pending} disabled={label.trim() === ""}>
            Rename
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
