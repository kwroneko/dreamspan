// The lorebook document's form (DATA-MODEL §3.3), shared by the card's embedded book and the
// standalone lorebook editor. Every edit is a field draft in the owning entry's EditorStore.
import { useContext, useEffect, useRef, useState } from "react"
import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import { Button } from "../../ui/Button.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { FieldTools, NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import { emptyBook, emptyEntry } from "./lorebookDefaults.ts"
import { entryMatches } from "./lorebookFields.ts"
import { SearchNavigation, scrollToSearchField } from "./searchNavigation.ts"
import { type EditorStore, useText, useValue } from "./store.ts"

const EMPTY_KEYS: ReadonlyArray<string> = []

/** One key per line: commas in a /pattern/flags key must survive unchanged. */
function Keys({ store, path, label }: { store: EditorStore; path: FieldPath; label: string }) {
  const match = useContext(SearchNavigation)
  const target = useRef<HTMLTextAreaElement>(null)
  const revealed = useRef<typeof match>(null)
  const keys = useValue<ReadonlyArray<string>>(store, path) ?? EMPTY_KEYS
  const field = valueField(path)
  const pathKey = JSON.stringify(path)
  useEffect(() => {
    if (!match || revealed.current === match || JSON.stringify(match.path.slice(0, -1)) !== pathKey) return
    const input = target.current!
    for (let parent = input.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
    }
    const index = Number(match.path.at(-1))
    const offset = keys.slice(0, index).reduce((n, key) => n + key.length + 1, 0)
    const frame = requestAnimationFrame(() => {
      // Apply a visit once; subsequent typing must retain the user's new caret.
      revealed.current = match
      input.focus({ preventScroll: true })
      input.setSelectionRange(offset + match.at, offset + match.at + match.length)
      scrollToSearchField(input)
    })
    return () => cancelAnimationFrame(frame)
  }, [match, pathKey, keys])
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={label} description="One key per line. Regular expressions use /pattern/flags.">
        <Textarea
          ref={target}
          rows={2}
          value={keys.join("\n")}
          onChange={(event) =>
            store.setValue(path, event.currentTarget.value === "" ? [] : event.currentTarget.value.split("\n"))
          }
          onBlur={() => void store.save(field)}
        />
      </Field>
      <FieldTools store={store} field={field} label={label} />
    </div>
  )
}

/** Null follows the chat's setting; imported explicit false must remain distinct. */
function InheritedSwitch({ store, path, label }: { store: EditorStore; path: FieldPath; label: string }) {
  const value = useValue<boolean | null>(store, path)
  return (
    <div className="flex flex-col gap-1">
      <Field label={label}>
        <Select
          value={value === null ? "inherit" : String(value)}
          items={[
            { value: "inherit", label: "Follow chat setting" },
            { value: "true", label: "On" },
            { value: "false", label: "Off" }
          ]}
          onValueChange={(next) => store.setValue(path, next === "inherit" ? null : next === "true")}
        />
      </Field>
      <FieldTools store={store} field={valueField(path)} label={label} />
    </div>
  )
}

/** A closed entry's keys and the start of its text, so a long book can be read without opening each. */
function EntryGlance({ store, path, entry }: { store: EditorStore; path: FieldPath; entry: LorebookEntry }) {
  const content = useText(store, [...path, "content"])
  const keys = entry.constant ? "Always included" : entry.keys.length > 0 ? entry.keys.join(", ") : "No keys"
  const preview = content.replace(/\s+/g, " ").trim()
  return (
    <span className="mt-1 block text-sm text-muted">
      <span className="block [overflow-wrap:anywhere]">
        {entry.enabled ? "" : "Off · "}
        {keys}
      </span>
      {preview && <span className="line-clamp-2 block [overflow-wrap:anywhere]">{preview}</span>}
    </span>
  )
}

function Entry({
  store,
  root,
  entry,
  initiallyOpen
}: {
  store: EditorStore
  root: FieldPath
  entry: LorebookEntry
  initiallyOpen: boolean
}) {
  const match = useContext(SearchNavigation)
  const [open, setOpen] = useState(initiallyOpen)
  const uid = entry.uid
  const path = [...root, "entries", `uid=${uid}`]
  const pathKey = JSON.stringify(path)
  const depth = path.length
  useEffect(() => {
    if (!match || JSON.stringify(match.path.slice(0, depth)) !== pathKey) return
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [match, pathKey, depth])
  const title = useText(store, [...path, "comment"]) || "Untitled entry"
  return (
    <details
      className="rounded-lg border border-border p-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer [overflow-wrap:anywhere]">
        <span className="font-medium">{title}</span>
        {!open && <EntryGlance store={store} path={path} entry={entry} />}
      </summary>
      {open && (
        <div role="group" aria-label={`Lorebook entry ${uid}`} className="mt-3 flex min-w-0 flex-col gap-4">
          <TextField store={store} path={[...path, "comment"]} label="Entry title" />
          <SwitchField store={store} path={[...path, "enabled"]} label="Entry enabled" />
          <SwitchField
            store={store}
            path={[...path, "constant"]}
            label="Always include"
            description="Include without a keyword match."
          />
          <Keys store={store} path={[...path, "keys"]} label="Primary keys" />
          <TextField store={store} path={[...path, "content"]} label="Entry content" rows={6} />
          <details>
            <summary className="cursor-pointer text-sm font-medium">Matching and placement</summary>
            <div className="mt-3 flex flex-col gap-4">
              <InheritedSwitch store={store} path={[...path, "case_sensitive"]} label="Case sensitive" />
              <InheritedSwitch store={store} path={[...path, "match_whole_words"]} label="Whole words" />
              <SwitchField store={store} path={[...path, "selective"]} label="Use secondary keys" />
              <Keys store={store} path={[...path, "secondary_keys"]} label="Secondary keys" />
              <SelectField
                store={store}
                path={[...path, "selective_logic"]}
                label="Secondary key logic"
                items={[
                  { value: "and_any", label: "Match any" },
                  { value: "and_all", label: "Match all" },
                  { value: "not_any", label: "Match none" },
                  { value: "not_all", label: "Not all match" }
                ]}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField store={store} path={[...path, "order"]} label="Insertion order" />
                <SelectField
                  store={store}
                  path={[...path, "position"]}
                  label="Position"
                  items={[
                    { value: "before_char", label: "Before character definitions" },
                    { value: "after_char", label: "After character definitions" },
                    { value: "an_top", label: "Before author's note" },
                    { value: "an_bottom", label: "After author's note" },
                    { value: "at_depth", label: "At depth" },
                    { value: "em_top", label: "Before examples" },
                    { value: "em_bottom", label: "After examples" },
                    { value: "outlet", label: "Outlet" }
                  ]}
                />
                <NumberField store={store} path={[...path, "depth"]} label="Depth" integer min={0} />
                <SelectField
                  store={store}
                  path={[...path, "role"]}
                  label="Role"
                  items={[
                    { value: "system", label: "System" },
                    { value: "user", label: "User" },
                    { value: "assistant", label: "Assistant" }
                  ]}
                />
              </div>
              <TextField store={store} path={[...path, "outlet_name"]} label="Outlet name" />
              <p className="text-sm text-muted">
                Chats place lore below the history by default. A chat's lorebook settings can allow these positions.
              </p>
              <SwitchField store={store} path={[...path, "use_probability"]} label="Use probability" />
              <NumberField store={store} path={[...path, "probability"]} label="Probability (%)" min={0} max={100} />
              <NumberField
                store={store}
                path={[...path, "scan_depth"]}
                label="Entry scan depth (empty follows chat)"
                integer
                nullable
                min={0}
              />
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Groups, timing and recursion</summary>
            <div className="mt-3 flex flex-col gap-4">
              <TextField store={store} path={[...path, "group"]} label="Inclusion group" />
              <SwitchField
                store={store}
                path={[...path, "group_override"]}
                label="Prioritize this entry in its group"
              />
              <NumberField store={store} path={[...path, "group_weight"]} label="Group weight" min={0} />
              <InheritedSwitch store={store} path={[...path, "use_group_scoring"]} label="Group scoring" />
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField store={store} path={[...path, "sticky"]} label="Sticky turns" integer nullable min={0} />
                <NumberField
                  store={store}
                  path={[...path, "cooldown"]}
                  label="Cooldown turns"
                  integer
                  nullable
                  min={0}
                />
                <NumberField store={store} path={[...path, "delay"]} label="Delay turns" integer nullable min={0} />
              </div>
              <SwitchField
                store={store}
                path={[...path, "exclude_recursion"]}
                label="Exclude from recursive matching"
              />
              <SwitchField store={store} path={[...path, "prevent_recursion"]} label="Prevent further recursion" />
              <SwitchField store={store} path={[...path, "ignore_budget"]} label="Ignore token budget" />
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => void store.removeItem(path)}>
              Remove entry
            </Button>
            <FieldTools store={store} field={valueField(path)} label={title} />
          </div>
        </div>
      )}
    </details>
  )
}

/** A new entry with a random safe integer uid: never reuses a removed entry's or a saved revision's. */
const addEntry = (store: EditorStore, root: FieldPath, book: LorebookDoc | undefined) => {
  let uid: number
  do uid = crypto.getRandomValues(new Uint32Array(1))[0]!
  while (book?.entries.some((entry) => entry.uid === uid))
  const entry: LorebookEntry = emptyEntry(uid)
  if (!book) store.setValue(root, { ...emptyBook(), entries: [entry] })
  else store.setValue([...root, "entries", `uid=${uid}`], entry)
  return uid
}

/**
 * The book's settings and its entries at `root` in the store's document: `["character_book"]` in
 * a card, the whole document for a standalone lorebook. `book` is undefined only for a card
 * without an embedded book; adding an entry then creates it.
 */
export function LorebookForm({ store, root, absent }: { store: EditorStore; root: FieldPath; absent: string }) {
  const book = useValue<LorebookDoc | undefined>(store, root)
  const [addedUid, setAddedUid] = useState<number | null>(null)
  const [filter, setFilter] = useState("")
  const match = useContext(SearchNavigation)
  const entriesKey = JSON.stringify([...root, "entries"])
  useEffect(() => {
    // A search visit to an entry the filter hides shows every entry again.
    if (!match || JSON.stringify(match.path.slice(0, root.length + 1)) !== entriesKey) return
    const frame = requestAnimationFrame(() => setFilter(""))
    return () => cancelAnimationFrame(frame)
  }, [match, entriesKey, root.length])
  // Titles and text match as typed, including unsaved drafts.
  const working = (entry: LorebookEntry): LorebookEntry => {
    const path = [...root, "entries", `uid=${entry.uid}`]
    return {
      ...entry,
      comment: store.text([...path, "comment"]),
      content: store.text([...path, "content"])
    }
  }
  const shown = book ? book.entries.filter((entry) => entryMatches(working(entry), filter)) : []
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {book ? (
        <>
          <TextField store={store} path={[...root, "name"]} label="Lorebook name" />
          <TextField store={store} path={[...root, "description"]} label="Lorebook description" rows={3} />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              store={store}
              path={[...root, "scan_depth"]}
              label="Book scan depth (empty follows chat)"
              integer
              nullable
              min={0}
            />
            <NumberField
              store={store}
              path={[...root, "token_budget"]}
              label="Book token budget (empty follows chat)"
              integer
              nullable
              min={0}
            />
          </div>
          <InheritedSwitch store={store} path={[...root, "recursive_scanning"]} label="Recursive scanning" />
          {book.entries.length > 1 && (
            <Field
              label="Filter entries"
              description={
                filter.trim() === ""
                  ? `${book.entries.length} entries.`
                  : `${shown.length} of ${book.entries.length} entries match.`
              }
            >
              <Input type="search" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
            </Field>
          )}
          {shown.map((entry, index) => (
            <Entry
              key={entry.uid}
              store={store}
              root={root}
              entry={entry}
              initiallyOpen={(index === 0 && filter.trim() === "") || entry.uid === addedUid}
            />
          ))}
          {book.entries.length === 0 && <p className="text-sm text-muted">No entries yet.</p>}
        </>
      ) : (
        <p className="text-sm text-muted">{absent}</p>
      )}
      <div>
        <Button
          onClick={() => {
            setFilter("")
            setAddedUid(addEntry(store, root, book))
          }}
        >
          Add lorebook entry
        </Button>
      </div>
    </div>
  )
}
