// A description of preset changes waiting for the header's Save or Revert. Text and
// prompt switches stay live; structural edits wait until a revision is saved.
import { describePresetChanges } from "./presetChanges.ts"
import { type EditorStore, useHeld, useWorkingDoc } from "./store.ts"

/**
 * Says what is held, at the bottom of the panel scroll or below the large toolbar.
 * Only the header cluster saves or reverts; this description disappears when nothing is held.
 * Its own component, so typing re-renders only it.
 */
export function HeldChangesBar({ store, floating = false }: { store: EditorStore; floating?: boolean }) {
  const held = useHeld(store)
  // Re-rendered as the document changes: the bar describes the live preset against the shown one.
  useWorkingDoc(store)
  if (held === "") return null
  const parts = describePresetChanges(store.beforeHeld(), store.arranged(), [])
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
    </div>
  )
}
