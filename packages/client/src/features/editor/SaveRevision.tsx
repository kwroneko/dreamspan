// Saving a revision from an editor (owner, 2026-11-01 and 2026-11-02; ARCHITECTURE §14.6):
// `ui/SaveControls` bound to the store; a failed save shows on Save itself. Save asks nothing:
// what's typed is used as it's typed, and a revision is a checkpoint. Only fields another tab
// or an update changed meanwhile open a dialog, to pick per field. A card's chat name asks about past messages where it's renamed (`CardNameHeader`),
// never after a save. Every editor uses it: the library page, the chat's tabs, a card's or
// chat's notes.
import { parseField } from "@rp/shared/editing.ts"
import { EditConflict, type SavedRef } from "@rp/shared/editorApi.ts"
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { SaveControls } from "../../ui/SaveControls.tsx"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { type Choice, type Conflict, ConflictPicker, chosen } from "./conflicts.tsx"
import { draftLabel } from "./fields.ts"
import { type EditorStore, useEditorState, useHeld, useText } from "./store.ts"

/** Whether a draft's content is text or JSON, for putting a picked value back. */
const contentOf = (field: string, value: unknown) =>
  parseField(field)?.kind === "value" ? JSON.stringify(value) : typeof value === "string" ? value : ""

export function SaveRevision({ store, onSaved }: { store: EditorStore; onSaved?: (saved: SavedRef) => void }) {
  const state = useEditorState(store)
  const held = useHeld(store)
  const ref = state.snapshot!.ref
  const name = useText(store, ["name"]) ?? ""
  const version = useText(store, ["character_version"]) ?? ""
  const nameCheck = useCardNameCheck(name, version, ref)
  const clash = ref.kind === "card" ? nameCheck : null
  const [pending, setPending] = useState(false)
  /** Why the last save failed: shown on Save itself, in its explanation. */
  const [failure, setFailure] = useState<string | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [conflicts, setConflicts] = useState<{ list: ReadonlyArray<Conflict>; message: string | null } | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})

  const save = async (message: string | null): Promise<boolean> => {
    if (clash) return false
    setPending(true)
    setFailure(null)
    setError(null)
    const result = await store.commit(message)
    setPending(false)
    if (result.ok) {
      onSaved?.(result.value)
      return true
    }
    if (result.cause instanceof EditConflict) {
      const doc = store.working().doc
      setConflicts({
        message,
        list: result.cause.fields.map(({ field, saved, draft }) => ({
          key: field,
          label: draftLabel(ref.kind, doc, field),
          mine: draft,
          theirs: saved
        }))
      })
      setChoices(Object.fromEntries(result.cause.fields.map(({ field }) => [field, { side: "mine" } as Choice])))
      return false
    }
    setFailure(result.error.message)
    return false
  }

  /** Revert: every changed field back to the last revision, its text now kept in its edit history. */
  const revert = async () => {
    setFailure(null)
    setError(null)
    const result = await store.revert()
    if (!result.ok) setError(result.error)
  }

  /** Puts each pick back as the field's draft, on the saved version, then saves again. */
  const resolve = async () => {
    if (conflicts === null) return
    setPending(true)
    for (const conflict of conflicts.list) {
      const choice = choices[conflict.key]!
      const result = await store.rebase(
        conflict.key,
        choice.side === "theirs" ? null : contentOf(conflict.key, chosen(conflict, choice))
      )
      if (result && !result.ok) {
        setPending(false)
        return setFailure(result.error.message)
      }
    }
    setPending(false)
    const message = conflicts.message
    setConflicts(null)
    await save(message)
  }

  return (
    <>
      <SaveControls
        changed={state.dirty > 0 || held !== ""}
        pending={pending}
        blocked={clash}
        failed={failure}
        onSave={save}
        onRevert={revert}
      />
      {error && <ErrorAlert error={error} />}
      {conflicts !== null && (
        <Dialog
          wide
          open
          onOpenChange={(open) => !open && !pending && setConflicts(null)}
          title="Changed meanwhile"
          description="Someone changed these fields while you were editing. Choose which text to keep before saving."
        >
          <ul aria-label="Changed meanwhile" className="flex flex-col gap-3">
            {conflicts.list.map((conflict) => (
              <ConflictPicker
                key={conflict.key}
                conflict={conflict}
                choice={choices[conflict.key]!}
                onChoice={(choice) => setChoices({ ...choices, [conflict.key]: choice })}
                mineLabel="Your version"
                theirsLabel="Saved version"
              />
            ))}
          </ul>
          <DialogActions>
            <Button
              onClick={() => setConflicts(null)}
              disabled={pending}
              hint="Saves nothing; your text stays as it is."
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              pending={pending}
              hint="Keeps what you picked for each field and saves the revision."
              onClick={() => void resolve()}
            >
              Use these and save
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  )
}
