// Taking in an update from what this ref follows: a new import of the file, or the changes
// of the entry a variant follows (§3.9). Without conflicts it's one click; with them, the
// user picks per field: theirs, mine, or an edit (DESIGN §4).
import type { MergePreview } from "@rp/shared/library.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import type { Caller } from "./caller.ts"
import { type Choice, type Conflict, ConflictPicker, resolution } from "./conflicts.tsx"
import { fieldLabel } from "./fields.ts"
import { type EditorStore, useEditorState } from "./store.ts"

export function UpdateDialog({ store, call, onClose }: { store: EditorStore; call: Caller; onClose: () => void }) {
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [choices, setChoices] = useState<ReadonlyArray<Choice>>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const snapshot = useEditorState(store).snapshot!

  useEffect(() => {
    void call((client) => client("PreviewUpdate", { refId: store.refId })).then((result) => {
      if (!result.ok) return setError(result.error)
      setPreview(result.value)
      setChoices(result.value.conflicts.map(() => ({ side: "mine" })))
    })
  }, [call, store])

  // No `preview!` here or in the closures below: the compiler reads a closure's dependencies
  // as it renders, before there's a preview.
  const conflicts: ReadonlyArray<Conflict> = (preview === null ? [] : preview.conflicts).map((conflict) => ({
    key: conflict.path.join("/"),
    label: fieldLabel(snapshot.ref.kind, preview === null ? {} : preview.merged, conflict.path),
    mine: conflict.ours,
    theirs: conflict.theirs,
    base: conflict.base
  }))

  const finish = async (run: () => Promise<{ ok: boolean; error?: AppError }>) => {
    setPending(true)
    const result = await run()
    setPending(false)
    if (!result.ok) return setError(result.error ?? null)
    await store.refresh()
    onClose()
  }

  const apply = () => finish(() => call((client) => client("ApplyUpdate", { refId: store.refId }), ["library"]))

  const resolve = (preview: MergePreview) => {
    const doc = resolution(
      preview.merged,
      preview.conflicts.map((conflict) => conflict.path),
      conflicts,
      choices
    )
    if (doc === null) {
      setError({
        tag: "Invalid",
        message: "One of these choices doesn't fit the document.",
        problems: [],
        reason: null
      })
      return
    }
    return finish(() =>
      call(
        (client) =>
          client("ResolveUpdate", {
            refId: store.refId,
            doc,
            theirsRevisionId: preview.theirsRevisionId,
            expectedRowVersion: snapshot.ref.rowVersion
          }),
        ["library"]
      )
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Update"
      description={
        snapshot.ref.refKind === "upstream"
          ? "A newer version of the file was imported. Your own edits are kept where the file didn't change the same passage."
          : "The entry this variant follows has changed. The variant's own edits are kept where they don't overlap."
      }
    >
      <ErrorAlert error={error} />
      {preview === null && error === null && <p className="text-sm text-muted">Comparing…</p>}
      {preview !== null && preview.conflicts.length === 0 && (
        <p className="text-sm">
          {preview.outcome === "up_to_date"
            ? "Nothing new: this already has every change."
            : "Everything merges without conflicts."}
        </p>
      )}
      {conflicts.length > 0 && (
        <>
          <p className="text-sm">Both sides changed these. Pick what each should be:</p>
          <ul aria-label="Conflicts" className="flex flex-col gap-3">
            {conflicts.map((conflict, index) => (
              <ConflictPicker
                key={conflict.key}
                conflict={conflict}
                choice={choices[index]!}
                onChoice={(choice) => setChoices(choices.map((old, i) => (i === index ? choice : old)))}
                mineLabel="Your version"
                theirsLabel="Their version"
              />
            ))}
          </ul>
        </>
      )}
      <DialogActions>
        <Button hint="Closes this dialog without applying changes." onClick={onClose}>
          Cancel
        </Button>
        {preview !== null && (
          <Button
            hint="Applies the selected source changes."
            variant="primary"
            pending={pending}
            onClick={() => void (conflicts.length > 0 ? resolve(preview) : apply())}
          >
            {conflicts.length > 0 ? "Apply these" : "Update"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
