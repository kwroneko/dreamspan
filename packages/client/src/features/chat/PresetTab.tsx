import type { AppError } from "../../errors.ts"
import { writePresetOrder } from "../editor/presetDraft.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { newestMessage, presetOrder } from "@rp/shared/presetOrder.ts"
import { lazy, Suspense, useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { valueField } from "@rp/shared/editing.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { type EditorStore, useEditorState, useLeaveGuard, useValue, useWorkingDoc } from "../editor/store.ts"
import type { ChatView } from "./session.ts"

/** What flipping a switch writes: the order, and the newest-message marker an older revision gains. */
const switchFields = new Set([valueField(["order"]), valueField(["prompts", "identifier=newestMessage"])])

const SaveDialog = lazy(() => import("../editor/SaveDialog.tsx").then((m) => ({ default: m.SaveDialog })))

function PresetSwitches({ store }: { store: EditorStore }) {
  const workspace = usePresetWorkspace()
  const state = useEditorState(store)
  const doc = useWorkingDoc(store)
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const order = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    void store.load()
  }, [store])
  useLeaveGuard(store)
  if (state.loadError) return <ErrorAlert error={state.loadError} />
  if (!state.snapshot) return <p role="status">Loading preset…</p>
  const all = [...prompts, newestMessage]
  const discard = async () => {
    setConfirming(false)
    for (const field of store.dirtyFields()) {
      const result = await store.discard(field)
      if (result && !result.ok) {
        setError(result.error)
        break
      }
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium">{state.snapshot.ref.label}</p>
      <p className="text-xs text-muted">
        Switches edit this preset everywhere it is used. Save a revision to apply changes.
      </p>
      <ErrorAlert error={error ?? state.saveError} />
      {state.dirty > 0 && (
        <div className="sticky top-0 z-10 flex gap-2 bg-surface py-2">
          <Button variant="primary" onClick={() => setSaving(true)}>
            Save
          </Button>
          <Button
            onClick={() => {
              // The switches alone go at once; anything else edited in the overlay is confirmed first.
              if (store.dirtyFields().every((field) => switchFields.has(field))) void discard()
              else setConfirming(true)
            }}
          >
            Discard
          </Button>
        </div>
      )}
      <ol className="divide-y divide-border" aria-label="Preset blocks">
        {presetOrder(prompts, order).map((entry) => {
          const p = all.find((p) => p.identifier === entry.identifier)!
          const content =
            (doc.prompts as PresetPrompt[] | undefined)?.find((p) => p.identifier === entry.identifier)?.content ?? ""
          const filled = workspace.context?.blocks.find((b) => b.identifier === entry.identifier)
          return (
            <li key={entry.identifier} className="flex flex-wrap items-center gap-2 py-2">
              {entry.identifier !== "newestMessage" && (
                <Switch
                  checked={entry.enabled}
                  onCheckedChange={(enabled) =>
                    writePresetOrder(
                      store,
                      presetOrder(prompts, order).map((e) =>
                        e.identifier === entry.identifier ? { ...e, enabled } : e
                      )
                    )
                  }
                >
                  <span className="sr-only">Send {p.name}</span>
                </Switch>
              )}
              <span className="min-w-0 flex-1 text-sm break-words">{p.name}</span>
              <span className="text-xs text-muted">
                ~{(p.marker ? (filled?.tokens ?? 0) : Math.ceil(content.length / 4)).toLocaleString()} tokens
              </span>
              <Button
                variant="ghost"
                aria-label={`Edit ${p.name}`}
                onClick={() => workspace.open(store.refId, entry.identifier)}
              >
                Edit
              </Button>
            </li>
          )
        })}
      </ol>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Discard ${state.dirty} unsaved ${state.dirty === 1 ? "change" : "changes"}?`}
        description="This includes changes made in the preset editor, such as prompt text, not only the switches. Discarded text is kept in the bin's recovered texts."
        confirmLabel="Discard them"
        onConfirm={() => void discard()}
      />
      {saving && (
        <Suspense>
          <SaveDialog store={store} onClose={() => setSaving(false)} onSaved={() => setSaving(false)} />
        </Suspense>
      )}
    </div>
  )
}
export function PresetTab({ view }: { view: ChatView }) {
  const workspace = usePresetWorkspace()
  const preset = view.history?.preset
  return preset?.ref ? (
    <PresetSwitches key={preset.ref} store={workspace.store(preset.ref as RefId)} />
  ) : (
    <p className="text-sm text-muted">
      {preset?.scope === "builtin"
        ? "SillyTavern's built-in default. Import a preset to edit its prompts."
        : "Loading the current preset…"}
    </p>
  )
}
