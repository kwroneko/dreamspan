// Saving a revision from an editor (owner, 2026-11-01 and 2026-11-02; ARCHITECTURE §14.6):
// `ui/SaveControls` bound to the store; a failed save shows below the controls. Save asks nothing:
// what's typed is used as it's typed, and a revision is a checkpoint. Only fields another tab
// or an update changed meanwhile open a dialog, to pick per field. A card's nickname asks about past messages where it's renamed (`CardNameHeader`),
// never after a save. Every editor uses it: the library page, the chat's tabs, a card's or
// chat's notes.
import { parseField } from "@dreamspan/shared/editing.ts"
import { EditConflict, type SavedRef } from "@dreamspan/shared/editorApi.ts"
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { useUnsavedSource } from "../../ui/UnsavedChanges.tsx"
import { SaveControls } from "../../ui/SaveControls.tsx"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { type Choice, type Conflict, ConflictPicker, chosen } from "./conflicts.tsx"
import { useDurableForm } from "./durable.tsx"
import { draftLabel } from "./fields.ts"
import { type EditorStore, useEditorState, useHeld, useText } from "./store.ts"

const NO_CONFLICTS: {
  readonly conflicts: { readonly list: ReadonlyArray<Conflict>; readonly message: string | null } | null
  readonly choices: Readonly<Record<string, Choice>>
} = { conflicts: null, choices: {} }

/** Whether a draft's content is text or JSON, for putting a picked value back. */
const contentOf = (field: string, value: unknown) =>
  parseField(field)?.kind === "value" ? JSON.stringify(value) : typeof value === "string" ? value : ""

export function SaveRevision({
  store,
  onSaved,
  shownNameClash = null,
  adds = null
}: {
  store: EditorStore
  onSaved?: (saved: SavedRef) => void
  shownNameClash?: string | null
  /** A card from a card source, which saving adds to the user's cards: its name. */
  adds?: string | null
}) {
  useUnsavedSource(store.unsavedSource)
  const state = useEditorState(store)
  const held = useHeld(store)
  const ref = state.snapshot!.ref
  const name = useText(store, ["name"]) ?? ""
  const version = useText(store, ["character_version"]) ?? ""
  const nameCheck = useCardNameCheck(name, version, ref)
  const clash = ref.kind === "card" ? nameCheck : null
  const [pending, setPending] = useState(false)
  /** Why the last save failed, shown below the revision controls. */
  const [failure, setFailure] = useState<string | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  // The fields changed meanwhile and what's picked for each, "Edit it" text included, are kept
  // as typed (durable.tsx), so a reload brings the dialog back as it was.
  const picking = useDurableForm(`save-conflict:${ref.id}`, "Changed meanwhile", NO_CONFLICTS)
  const { conflicts, choices } = picking.values
  const setChoices = (next: Record<string, Choice>) => picking.edit({ choices: next })
  /** Closes the dialog: what was picked or typed goes to the bin, recoverable. */
  const cancel = () => {
    if (conflicts !== null) void picking.discard()
  }

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
      picking.replace({
        conflicts: {
          message,
          list: result.cause.fields.map(({ field, saved, draft }) => ({
            key: field,
            label: draftLabel(ref.kind, doc, field),
            mine: draft,
            theirs: saved
          }))
        },
        choices: Object.fromEntries(result.cause.fields.map(({ field }) => [field, { side: "mine" } as Choice]))
      })
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
      const choice = choices[conflict.key] ?? { side: "mine" }
      const result = await store.rebase(
        conflict.key,
        choice.side === "theirs" ? null : contentOf(conflict.key, chosen(conflict, choice))
      )
      if (result && !result.ok) {
        setPending(false)
        return setFailure(result.error.message)
      }
    }
    // Each pick is its field's draft now: this workspace is done with.
    await picking.commit(async () => true)
    setPending(false)
    await save(conflicts.message)
  }

  return (
    <>
      <SaveControls
        changed={state.dirty > 0 || held !== ""}
        pending={pending}
        blocked={clash}
        failed={shownNameClash ? null : failure}
        onSave={save}
        onRevert={revert}
        adds={adds}
      />
      {error && <ErrorAlert error={error} />}
      {conflicts !== null && (
        <Dialog
          wide
          open
          onOpenChange={(open) => !open && !pending && cancel()}
          title="Changed meanwhile"
          description="Someone changed these fields while you were editing. Choose which text to keep before saving."
        >
          <ul aria-label="Changed meanwhile" className="flex flex-col gap-3">
            {conflicts.list.map((conflict) => (
              <ConflictPicker
                key={conflict.key}
                conflict={conflict}
                choice={choices[conflict.key] ?? { side: "mine" }}
                onChoice={(choice) => setChoices({ ...choices, [conflict.key]: choice })}
                mineLabel="Your version"
                theirsLabel="Saved version"
              />
            ))}
          </ul>
          <DialogActions>
            <Button onClick={cancel} disabled={pending} hint="Saves nothing; your text stays as it is.">
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
