import { useCardNameCheck } from "./cardNameCheck.ts"
// Edit scope: making a named variant is one action. Card names live in revision content;
// other library entries retain their separate labels.
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
  const nameCheck = useCardNameCheck(label.trim(), subtitle.trim())
  const clash = ref.kind === "card" ? nameCheck : null
  const [moveDrafts, setMoveDrafts] = useState(dirty)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (clash) return
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
        <Field label={ref.kind === "card" ? "Display name" : "Library label"}>
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} required />
        </Field>
        <Field label={ref.kind === "card" ? "Version (shown as subtitle)" : "Subtitle (optional)"}>
          <Input value={subtitle} onChange={(event) => setSubtitle(event.currentTarget.value)} />
        </Field>
        {dirty && (
          <Checkbox checked={moveDrafts} onCheckedChange={setMoveDrafts}>
            Take my unsaved changes to the variant{ref.kind === "card" ? " (name and version drafts stay here)" : ""}
          </Checkbox>
        )}
        {clash && (
          <p role="status" className="text-sm text-muted">
            {clash}
          </p>
        )}
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={label.trim() === "" || clash !== null}
          >
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
  const nameCheck = useCardNameCheck(label.trim(), subtitle.trim(), ref)
  const clash = ref.kind === "card" ? nameCheck : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (clash) return
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
      description={
        ref.kind === "card"
          ? "Changes the card’s display name and version as a new revision."
          : "Changes the entry’s library label."
      }
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label={ref.kind === "card" ? "Display name" : "Library label"}>
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} required />
        </Field>
        <Field label={ref.kind === "card" ? "Version (shown as subtitle)" : "Subtitle (optional)"}>
          <Input value={subtitle} onChange={(event) => setSubtitle(event.currentTarget.value)} />
        </Field>
        {clash && (
          <p role="status" className="text-sm text-muted">
            {clash}
          </p>
        )}
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={label.trim() === "" || clash !== null}
          >
            Rename
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
