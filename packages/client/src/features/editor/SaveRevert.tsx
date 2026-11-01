// Save and Revert, side by side wherever an editor's unsaved changes are offered: the editor's
// toolbar and the Prompt preset tab's floating bar. One flow: Save opens the rich diff and saves
// a revision; Revert throws every draft away, asking first only when that loses typed text.
import type { SavedRef } from "@rp/shared/editorApi.ts"
import { parseField } from "@rp/shared/editing.ts"
import { lazy, Suspense, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { type EditorStore, useEditorState } from "./store.ts"

const SaveDialog = lazy(() => import("./SaveDialog.tsx").then((m) => ({ default: m.SaveDialog })))

/** Whether throwing the drafts away loses text typed (a prompt, a name, a field), not only switches and order. */
const draftsHoldText = (store: EditorStore) => store.dirtyFields().some((field) => parseField(field)?.kind === "text")

export function SaveRevert({
  store,
  current,
  onSaved,
  saveDisabled = false,
  what
}: {
  store: EditorStore
  /** The chat it's edited from, for what a save offers after it. */
  current?: { readonly chatId: string; readonly forkId: string | null } | undefined
  onSaved?: (saved: SavedRef) => void
  saveDisabled?: boolean
  /** What's unsaved, in words, for Revert's question. */
  what?: string | undefined
}) {
  const { dirty } = useEditorState(store)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const revert = async () => {
    setConfirming(false)
    setReverting(true)
    setError(null)
    for (const field of store.dirtyFields()) {
      const result = await store.discard(field)
      if (result && !result.ok) {
        setError(result.error)
        break
      }
    }
    setReverting(false)
  }
  return (
    <>
      <Tooltip label="Throw away every unsaved change">
        <Button
          pending={reverting}
          disabled={dirty === 0}
          onClick={() => {
            // Only typed text is worth a question: a reorder or a switch is quick to redo.
            if (draftsHoldText(store)) setConfirming(true)
            else void revert()
          }}
        >
          <Icon name="undo" />
          Revert
        </Button>
      </Tooltip>
      <Tooltip label="See every change, then save them as a new revision">
        <Button variant="primary" disabled={dirty === 0 || reverting || saveDisabled} onClick={() => setSaving(true)}>
          Save{dirty > 0 ? ` (${dirty})` : ""}
        </Button>
      </Tooltip>
      {error && <ErrorAlert error={error} />}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Revert ${dirty} unsaved ${dirty === 1 ? "change" : "changes"}?`}
        description={`This throws away text you typed${what ? ` (${what})` : ""}. Discarded text is kept in the bin's recovered texts.`}
        confirmLabel="Revert them"
        onConfirm={() => void revert()}
      />
      {saving && (
        <Suspense>
          <SaveDialog
            store={store}
            current={current}
            onClose={() => setSaving(false)}
            onSaved={(saved) => {
              setSaving(false)
              onSaved?.(saved)
            }}
          />
        </Suspense>
      )}
    </>
  )
}
