// Changes to many lorebook entries at once (owner, 2026-11-01): Enable all / Disable all, and
// "Change for selected…", which sets one setting on the selected entries and leaves every
// other setting as it was. The settings it offers are a registry a plugin can add to, replace
// or disable (spec/PLUGINS.md §8); the defaults are registered in lorebookColumns.tsx.
//
// A change to many entries is an ordinary unsaved change, as any edit is (owner, 2026-11-02:
// "Isn't that how you would undo it if they didn't save themselves?"): Revert beside Save
// undoes it and Save keeps it. No revision is cut for it, and its toast has no Undo of its own.
import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
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

/**
 * Applies `edits` as unsaved changes, as typing is: see the top of this file. `label` names the
 * change: "Disabled all 40 entries".
 */
export function applyMassChange(store: EditorStore, label: string, edits: ReadonlyArray<EntryEdit>) {
  if (edits.length === 0) {
    showToast({ title: "Nothing to change", description: "Every entry already has that." })
    return
  }
  for (const edit of edits) store.setValue(edit.path, edit.value)
  showToast({ title: label, description: "Unsaved: Save keeps it, Revert undoes it." })
}
