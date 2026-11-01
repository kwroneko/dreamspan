// Saving a revision from an editor (owner, 2026-11-01; ARCHITECTURE §14.6): `ui/SaveControls`
// bound to the store. Save asks nothing: what's typed is used as it's typed, and a revision is a
// checkpoint. Only fields another tab or an update changed meanwhile open a dialog, to pick per
// field; a card whose in-chat name changed offers what its contributions offer after (renaming
// in chats). Every editor uses it: the library page, the chat's tabs, a card's or chat's notes.
import { cardNames } from "@rp/shared/cardNames.ts"
import { ChatId, ForkId } from "@rp/shared/chat.ts"
import { parseField } from "@rp/shared/editing.ts"
import { EditConflict, type SavedRef } from "@rp/shared/editorApi.ts"
import { useSearch } from "@tanstack/react-router"
import { Schema } from "effect"
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { SaveControls } from "../../ui/SaveControls.tsx"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { type CardSaved, cardSavedContribution } from "./cardSaved.ts"
import { CardSavedFlow } from "./CardSavedFlow.tsx"
import { type Choice, type Conflict, ConflictPicker, chosen } from "./conflicts.tsx"
import { draftLabel } from "./fields.ts"
import { type EditorStore, useEditorState, useHeld, useText } from "./store.ts"

/** Whether a draft's content is text or JSON, for putting a picked value back. */
const contentOf = (field: string, value: unknown) =>
  parseField(field)?.kind === "value" ? JSON.stringify(value) : typeof value === "string" ? value : ""

export function SaveRevision({
  store,
  current,
  onSaved,
  showState = true,
  compact = false
}: {
  store: EditorStore
  /** The chat it's edited from, for the rename offer after a card's save; else the URL's (`renameChat`). */
  current?: { readonly chatId: string; readonly forkId: string | null } | undefined
  onSaved?: (saved: SavedRef) => void
  showState?: boolean
  /** A crowded toolbar (`SaveControls` `compact`). */
  compact?: boolean
}) {
  const state = useEditorState(store)
  const held = useHeld(store)
  const url = useSearch({ strict: false }) as { renameChat?: unknown; renameFork?: unknown }
  const search = current ? { renameChat: current.chatId, renameFork: current.forkId } : url
  const ref = state.snapshot!.ref
  const name = useText(store, ["name"]) ?? ""
  const version = useText(store, ["character_version"]) ?? ""
  const nameCheck = useCardNameCheck(name, version, ref)
  const clash = ref.kind === "card" ? nameCheck : null
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [conflicts, setConflicts] = useState<{ list: ReadonlyArray<Conflict>; message: string | null } | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [followup, setFollowup] = useState<{ change: CardSaved; saved: SavedRef } | null>(null)

  const save = async (message: string | null): Promise<boolean> => {
    if (clash) return false
    setPending(true)
    setError(null)
    const oldName = cardNames(store.head).modelName
    const result = await store.commit(message)
    setPending(false)
    if (result.ok) {
      if (ref.kind === "card") {
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
        if (cardSavedContribution(change)) {
          setFollowup({ change, saved: result.value })
          return true
        }
      }
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
    setError(result.error)
    return false
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
        return setError(result.error)
      }
    }
    setPending(false)
    const message = conflicts.message
    setConflicts(null)
    await save(message)
  }

  if (followup)
    return (
      <CardSavedFlow
        change={followup.change}
        onDone={() => {
          const saved = followup.saved
          setFollowup(null)
          onSaved?.(saved)
        }}
      />
    )
  return (
    <>
      <SaveControls
        revision={store.revisionNumber}
        changed={state.dirty > 0 || held !== ""}
        pending={pending}
        blocked={clash}
        showState={showState}
        compact={compact}
        onSave={save}
      />
      {error && <ErrorAlert error={error} />}
      {conflicts !== null && (
        <Dialog
          wide
          open
          onOpenChange={(open) => !open && !pending && setConflicts(null)}
          title="Changed meanwhile"
          description="These fields changed in the saved version since you started editing them. Pick what each should be, then it saves."
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
