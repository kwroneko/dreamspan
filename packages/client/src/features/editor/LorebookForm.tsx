import { Tooltip } from "../../ui/Tooltip.tsx"
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
export function BookSettings({ store, root, entries }: { store: EditorStore; root: FieldPath; entries: number }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="@container group rounded-lg border border-border p-3"
    >
      <Tooltip label={open ? "Click to hide this lorebook’s settings." : "Click to show this lorebook’s settings."}>
        <summary className="cursor-pointer text-sm font-medium">
          Book settings{" "}
          <span className="hidden font-normal text-muted sm:inline">· description, scan depth, budget, recursion</span>
        </summary>
      </Tooltip>
      <div className="mt-3 flex flex-col gap-4">
        {/* A library lorebook is renamed by the pencil beside its name, which sets this too. */}
        {root.length > 0 && <TextField store={store} path={[...root, "name"]} label="Lorebook name" />}
        <TextField
          store={store}
          path={[...root, "description"]}
          label="Lorebook description"
          about="For you: it isn't sent to the model."
          rows={3}
        />
        <div className="grid gap-4 @min-[30rem]:grid-cols-3">
          <NumberField
            store={store}
            path={[...root, "scan_depth"]}
            label="Scan depth"
            about="Check this many recent messages for keys. Empty uses 2; entries can choose their own depth."
            integer
            nullable
            min={0}
          />
          <NumberField
            store={store}
            path={[...root, "token_budget"]}
            label="Token budget"
            about="Limit how much room this book’s entries take, in tokens. Empty adds no limit for this book. All books also share a lorebook budget."
            integer
            nullable
            min={0}
          />
          <InheritedSwitch
            store={store}
            path={[...root, "recursive_scanning"]}
            label="Recursive scanning"
            fallback="on"
            description="Entries' text can trigger other entries."
          />
        </div>
        <p className="text-sm text-muted">
          {entries.toLocaleString()} {entries === 1 ? "entry" : "entries"}.
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
