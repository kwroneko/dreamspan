// Save and Revert for a preset's held changes (owner, 2026-11-01): prompts moved or deleted,
// easy to do by accident, wait in the Prompt preset tab's floating bar and the large editor's
// toolbar; everything else is live. Save applies them and saves a revision of the whole preset;
// Revert puts the prompts back where the live order has them, the deleted ones included, so
// it loses no text and asks nothing.
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { describePresetChanges } from "./presetChanges.ts"
import { type EditorStore, useHeld, useWorkingDoc } from "./store.ts"

/**
 * Says what's held, with Revert and Save: stuck to the bottom of the Prompt preset tab's
 * scroll (`floating`), or a line in the large editor's toolbar; gone once nothing is held.
 * Its own component, so typing re-renders only it.
 */
export function HeldChangesBar({ store, floating = false }: { store: EditorStore; floating?: boolean }) {
  const held = useHeld(store)
  const working = useWorkingDoc(store)
  if (held === "") return null
  const parts = describePresetChanges(working, store.arranged(), [])
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${
        floating
          ? "sticky bottom-0 z-20 mt-auto rounded-lg border border-accent/40 bg-surface-raised p-2.5 shadow-lg"
          : "rounded-md border border-accent/40 px-2.5 py-1.5"
      }`}
    >
      <p role="status" className="min-w-0 flex-1 basis-40 text-sm [overflow-wrap:anywhere]">
        <span className="font-medium">Unsaved:</span>{" "}
        <span className="text-muted">{parts.length > 0 ? parts.join(" · ") : "prompts moved"}</span>
      </p>
      <div className="ml-auto flex shrink-0 flex-wrap gap-2">
        <HeldSaveRevert store={store} />
      </div>
    </div>
  )
}

function HeldSaveRevert({ store }: { store: EditorStore }) {
  const held = useHeld(store)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const save = async () => {
    setPending(true)
    setError(null)
    const result = await store.commit(null)
    setPending(false)
    if (!result.ok) setError(result.error)
  }
  return (
    <>
      <Button
        disabled={held === "" || pending}
        hint="Puts the prompts back where they were, deleted ones included. Nothing typed is lost."
        onClick={() => store.revertHeld()}
      >
        <Icon name="undo" />
        Revert
      </Button>
      <Button
        variant="primary"
        pending={pending}
        disabled={held === ""}
        hint={`Applies the new order and deletions and saves revision ${store.revisionNumber + 1} of the preset.`}
        onClick={() => void save()}
      >
        Save
      </Button>
      {error && <ErrorAlert error={error} />}
    </>
  )
}
