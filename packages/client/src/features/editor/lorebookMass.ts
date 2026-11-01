// Changes to many lorebook entries at once (owner, 2026-11-01): Enable all / Disable all, and
// "Change for selected…", which sets one setting on the selected entries and leaves every
// other setting as it was. The settings it offers are a registry a plugin can add to, replace
// or disable (spec/PLUGINS.md §8); the defaults are registered in lorebookColumns.tsx.
//
// Undo: a change to many entries is a revision of its own. What was changed before it, since
// the last revision, is saved first as "Before: …"; then the change is applied and saved as
// "<what it did>". The toast's Undo restores the revision before it (RestoreRevision), and
// History lists both, so it can be undone later too, from any device.
import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { type FieldPath, getAt } from "@rp/shared/editing.ts"
import type { RevisionId } from "@rp/shared/library.ts"
import { makeRegistry } from "../../registry.ts"
import { showToast } from "../../ui/Toast.tsx"
import { entryPath } from "./lorebookTable.ts"
import type { EditorStore } from "./store.ts"

export type MassValue = string | number | boolean | null

/** How a setting's new value is picked in the dialog. */
type MassInput =
  | {
      readonly kind: "choice"
      readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly description?: string }>
    }
  | {
      readonly kind: "number"
      readonly min?: number
      readonly max?: number
      readonly integer?: boolean
      readonly nullable?: boolean
    }
  | { readonly kind: "switch"; readonly on: string; readonly off: string }
  | { readonly kind: "text" }

export interface LorebookMassSetting {
  readonly id: string
  readonly order: number
  readonly label: string
  /** What the setting does, as its explanation in the picker. */
  readonly description: string
  readonly input: MassInput
  /** The dialog's starting value: the first selected entry's. */
  readonly current: (entry: LorebookEntry) => MassValue
  /** The fields it sets for a value: only these change. */
  readonly patch: (value: MassValue) => Partial<LorebookEntry>
}
export const lorebookMassSettings = makeRegistry<LorebookMassSetting>()

export interface EntryEdit {
  readonly path: FieldPath
  readonly value: unknown
}

/** The edits a patch makes to these entries: only fields whose value differs. */
export const patchEdits = (
  root: FieldPath,
  entries: ReadonlyArray<LorebookEntry>,
  patch: Partial<LorebookEntry>
): ReadonlyArray<EntryEdit> =>
  entries.flatMap((entry) =>
    Object.entries(patch).flatMap(([key, value]) =>
      JSON.stringify(entry[key as keyof LorebookEntry]) === JSON.stringify(value)
        ? []
        : [{ path: [...entryPath(root, entry.uid), key], value }]
    )
  )

/** How many entries an edit list touches. */
export const touched = (edits: ReadonlyArray<EntryEdit>) => new Set(edits.map((edit) => String(edit.path.at(-2)))).size

const entriesOf = (store: EditorStore, root: FieldPath) =>
  ((store.value(root) as LorebookDoc | undefined)?.entries ?? []) as ReadonlyArray<LorebookEntry>

/** Every entry's own switch, on or off: the book stays as it is (owner: "it's not to disable the lorebook"). */
export const enableAllEdits = (store: EditorStore, root: FieldPath, enabled: boolean) =>
  patchEdits(root, entriesOf(store, root), { enabled })

const failed = (title: string, message: string) => showToast({ title, description: message, timeout: 12000 })

/**
 * Applies `edits` as a revision of their own, with the way back: see the top of this file.
 * `label` names the change: "Enabled all 40 entries".
 */
export async function applyMassChange(store: EditorStore, label: string, edits: ReadonlyArray<EntryEdit>) {
  if (edits.length === 0) {
    showToast({ title: "Nothing to change", description: "Every entry already has that." })
    return
  }
  // What was changed before it is a revision of its own, so Undo brings it back as it was.
  await store.flush()
  if (store.dirtyFields().length > 0) {
    const before = await store.commit(`Before: ${label}`)
    if (!before.ok) {
      failed(
        "Nothing was changed",
        `Your earlier changes couldn't be saved first (${before.error.message}). Save them, then try again.`
      )
      return
    }
  }
  const undoTo = store.snapshot?.ref.headRevisionId as RevisionId | undefined
  const previous = edits.map((edit) => ({ path: edit.path, value: getAt(store.working().doc, edit.path) }))
  for (const edit of edits) store.setValue(edit.path, edit.value)
  const saved = await store.commit(label)
  if (!saved.ok || !undoTo) {
    // Still applied, as changes since the last revision: Undo puts the old values back.
    showToast({
      title: label,
      description: `Not saved as a revision (${saved.ok ? "no revision to go back to" : saved.error.message}); Revert beside Save also undoes it.`,
      timeout: 12000,
      actions: [
        {
          label: "Undo",
          onClick: () => {
            for (const edit of previous) store.setValue(edit.path, edit.value)
          }
        }
      ]
    })
    return
  }
  showToast({
    title: label,
    description: `Saved as revision ${store.revisionNumber}. Undo restores revision ${store.revisionNumber - 1}; History has both.`,
    timeout: 12000,
    actions: [
      {
        label: "Undo",
        onClick: () =>
          void store.restoreRevision(undoTo).then((result) => {
            if (!result.ok)
              failed("Couldn't undo", `${result.error.message} History can restore the revision before it.`)
          })
      }
    ]
  })
}
