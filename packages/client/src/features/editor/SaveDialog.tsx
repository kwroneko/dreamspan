// Saving: what changed, field by field, then one revision with an optional message
// (DESIGN §6.2). Fields another tab or an update changed meanwhile are picked one by one.
import { parseField } from "@rp/shared/editing.ts"
import { EditConflict, type SavedRef } from "@rp/shared/editorApi.ts"
import { type FormEvent, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { type Choice, type Conflict, ConflictPicker, chosen } from "./conflicts.tsx"
import { ValueDiff } from "./diff.tsx"
import { changedFields, draftLabel, type FieldChange, fieldLabel } from "./fields.ts"
import { type EditorStore, useEditorState } from "./store.ts"

/** Whether a draft's content is text or JSON, for putting a picked value back. */
const contentOf = (field: string, value: unknown) =>
  parseField(field)?.kind === "value" ? JSON.stringify(value) : typeof value === "string" ? value : ""

export function SaveDialog({
  store,
  onClose,
  onSaved
}: {
  store: EditorStore
  onClose: () => void
  onSaved: (saved: SavedRef) => void
}) {
  const kind = useEditorState(store).snapshot!.ref.kind
  /** What will be saved: worked out once everything typed is on the server. */
  const [view, setView] = useState<{
    readonly working: ReturnType<EditorStore["working"]>
    readonly changes: ReadonlyArray<FieldChange>
  } | null>(null)
  const [message, setMessage] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [conflicts, setConflicts] = useState<ReadonlyArray<Conflict>>([])
  const [choices, setChoices] = useState<Record<string, Choice>>({})

  // Everything typed goes to the server first, so the diff is what will be saved.
  useEffect(() => {
    void store
      .flush()
      .then(async () => {
        const working = store.working()
        const changes = kind === "card" ? await store.comparisonChanges() : changedFields(store.head, working.doc)
        setView({ working, changes })
      })
      .catch((error: AppError) => setError(error))
  }, [store, kind])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setPending(true)
    const result = await store.commit(message.trim() === "" ? null : message.trim())
    setPending(false)
    if (result.ok) return onSaved(result.value)
    if (result.cause instanceof EditConflict) {
      const doc = store.working().doc
      setConflicts(
        result.cause.fields.map(({ field, saved, draft }) => ({
          key: field,
          label: draftLabel(kind, doc, field),
          mine: draft,
          theirs: saved
        }))
      )
      setChoices(Object.fromEntries(result.cause.fields.map(({ field }) => [field, { side: "mine" } as Choice])))
      setError(null)
    } else setError(result.error)
  }

  /** Puts each pick back as the field's draft, based on the saved version; then save again. */
  const resolve = async () => {
    setPending(true)
    for (const conflict of conflicts) {
      const choice = choices[conflict.key]!
      const value = chosen(conflict, choice)
      const result = await store.rebase(conflict.key, choice.side === "theirs" ? null : contentOf(conflict.key, value))
      if (result && !result.ok) {
        setPending(false)
        return setError(result.error)
      }
    }
    setPending(false)
    setConflicts([])
    const working = store.working()
    setView({
      working,
      changes: kind === "card" ? await store.comparisonChanges() : changedFields(store.head, working.doc)
    })
  }

  return (
    <Dialog
      wide={kind === "card"}
      open
      onOpenChange={(open) => !open && onClose()}
      title={conflicts.length > 0 ? "Changed meanwhile" : "Save a revision"}
      description={
        conflicts.length > 0
          ? "These fields changed in the saved version since you started editing them. Pick what each should be, then save again."
          : "Your changes become one revision in the history. Earlier revisions stay, and can be restored."
      }
    >
      <ErrorAlert error={error} />
      {conflicts.length > 0 ? (
        <>
          <ul aria-label="Changed meanwhile" className="flex flex-col gap-3">
            {conflicts.map((conflict) => (
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
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" pending={pending} onClick={() => void resolve()}>
              Use these
            </Button>
          </DialogActions>
        </>
      ) : (
        <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4">
          {view === null ? (
            <p className="text-sm text-muted">Saving your drafts…</p>
          ) : view.changes.length === 0 ? (
            <p className="text-sm text-muted">Nothing differs from the saved version.</p>
          ) : (
            <ul aria-label="Changes" className="flex flex-col gap-3">
              {view.changes.map((change) => {
                const label = fieldLabel(kind, view.working.doc, change.path)
                return (
                  <li key={label} className="flex flex-col gap-1">
                    <span className="text-sm font-medium [overflow-wrap:anywhere]">{label}</span>
                    <ValueDiff before={change.before} after={change.after} rich={kind === "card"} />
                  </li>
                )
              })}
            </ul>
          )}
          {view !== null && view.working.problems.length > 0 && (
            <Alert tone="warning" title="Some changes no longer fit the document">
              <ul className="list-disc pl-5">
                {view.working.problems.map((problem) => (
                  <li key={problem.field}>
                    {draftLabel(kind, view.working.doc, problem.field)}: {problem.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          <Field label="What changed (optional)">
            <Input value={message} onChange={(event) => setMessage(event.currentTarget.value)} />
          </Field>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" pending={pending} disabled={view === null}>
              Save revision
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  )
}
