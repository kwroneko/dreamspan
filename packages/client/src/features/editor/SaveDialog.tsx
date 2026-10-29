import { cardNames } from "@rp/shared/cardNames.ts"
import { ChatId, ForkId } from "@rp/shared/chat.ts"
import { Schema } from "effect"
import { useSearch } from "@tanstack/react-router"
import { cardSavedContribution, type CardSaved } from "./cardSaved.ts"
import { CardSavedFlow } from "./CardSavedFlow.tsx"
import { useCardNameCheck } from "./cardNameCheck.ts"
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
import { draftLabel, type FieldChange, fieldLabel } from "./fields.ts"
import { type EditorStore, useEditorState, useText } from "./store.ts"

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
  const search = useSearch({ strict: false }) as { renameChat?: unknown; renameFork?: unknown }
  const [followup, setFollowup] = useState<{
    change: CardSaved
    saved: SavedRef
  } | null>(null)
  const ref = useEditorState(store).snapshot!.ref
  const kind = ref.kind
  const name = useText(store, ["name"]) ?? ""
  const version = useText(store, ["character_version"]) ?? ""
  const nameCheck = useCardNameCheck(name, version, ref)
  const clash = kind === "card" ? nameCheck : null
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
        const changes = await store.comparisonChanges()
        setView({ working, changes })
      })
      .catch((error: AppError) => setError(error))
  }, [store, kind])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (clash) return
    setPending(true)
    const oldName = cardNames(store.head).modelName
    const result = await store.commit(message.trim() === "" ? null : message.trim())
    setPending(false)
    if (result.ok) {
      if (kind === "card") {
        const chatId = Schema.decodeUnknownOption(ChatId)(search.renameChat)
        const forkId = Schema.decodeUnknownOption(ForkId)(search.renameFork)
        const change: CardSaved = {
          entityId: ref.entityId,
          oldName,
          newName: result.value.ref.modelName ?? result.value.ref.label,
          ...(chatId._tag === "Some" && forkId._tag === "Some"
            ? { current: { chatId: chatId.value, forkId: forkId.value } }
            : {})
        }
        const contribution = cardSavedContribution(change)
        if (contribution) return setFollowup({ change, saved: result.value })
      }
      return onSaved(result.value)
    }
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
      changes: await store.comparisonChanges()
    })
  }

  if (followup) return <CardSavedFlow change={followup.change} onDone={() => onSaved(followup.saved)} />

  return (
    <Dialog
      wide
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={conflicts.length > 0 ? "Changed meanwhile" : "Save a revision"}
      description={
        conflicts.length > 0
          ? "These fields changed in the saved version since you started editing them. Pick what each should be, then save again."
          : "Your changes become one revision in the history. Earlier revisions stay, and can be restored."
      }
    >
      {clash && (
        <p role="status" className="text-sm text-muted">
          {clash}
        </p>
      )}
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
            <Button onClick={onClose} disabled={pending}>
              Cancel
            </Button>
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
                    <ValueDiff before={change.before} after={change.after} rich />
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
            <Button onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" pending={pending} disabled={view === null || clash !== null}>
              Save revision
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  )
}
