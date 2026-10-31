// The lorebook document's form (DATA-MODEL §3.3), shared by the card's embedded book and the
// standalone lorebook editor: the book's settings, and its entries as a table (LorebookTable)
// whose rows open to every field of the entry here. Every edit is a field draft in the owning
// entry's EditorStore.
import { useState } from "react"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import { Button } from "../../ui/Button.tsx"
import { NumberField, TextField } from "./controls.tsx"
import { InheritedSwitch } from "./LorebookEntryDetails.tsx"
import { addEntry } from "./lorebookTable.ts"
import { LorebookTable } from "./LorebookTable.tsx"
import { type EditorStore, useValue } from "./store.ts"

/** The book's own settings: name, description and what it overrides of the chat's. */
function BookSettings({ store, root, entries }: { store: EditorStore; root: FieldPath; entries: number }) {
  return (
    <details className="group rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Book settings{" "}
        <span className="hidden font-normal text-muted sm:inline">· name, description, scan depth, budget</span>
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        <TextField store={store} path={[...root, "name"]} label="Lorebook name" />
        <TextField store={store} path={[...root, "description"]} label="Lorebook description" rows={3} />
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            store={store}
            path={[...root, "scan_depth"]}
            label="Scan depth (empty follows the chat)"
            integer
            nullable
            min={0}
          />
          <NumberField
            store={store}
            path={[...root, "token_budget"]}
            label="Token budget (empty follows the chat)"
            integer
            nullable
            min={0}
          />
          <InheritedSwitch store={store} path={[...root, "recursive_scanning"]} label="Recursive scanning" />
        </div>
        <p className="text-sm text-muted">
          {entries.toLocaleString()} {entries === 1 ? "entry" : "entries"}. Chats place lore below the history by
          default; a chat's Lorebooks tab can let entries go where their positions say.
        </p>
      </div>
    </details>
  )
}

/**
 * The book's settings and its entries at `root` in the store's document: `["character_book"]` in
 * a card, the whole document for a standalone lorebook. `book` is undefined only for a card
 * without an embedded book; adding an entry then creates it.
 */
export function LorebookForm({ store, root, absent }: { store: EditorStore; root: FieldPath; absent: string }) {
  const book = useValue<LorebookDoc | undefined>(store, root)
  const [added, setAdded] = useState<number | null>(null)
  if (!book) {
    return (
      <div className="flex min-w-0 flex-col items-start gap-3">
        <p className="text-sm text-muted">{absent}</p>
        <Button onClick={() => setAdded(addEntry(store, root, book))}>Add entry</Button>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <BookSettings store={store} root={root} entries={book.entries.length} />
      <LorebookTable store={store} root={root} book={book} added={added} />
    </div>
  )
}
