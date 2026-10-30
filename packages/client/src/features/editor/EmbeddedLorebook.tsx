import { SearchNavigation, scrollToSearchField } from "./searchNavigation.ts"
import { useContext, useEffect, useRef, useState } from "react"
import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { type FieldPath, valueField } from "@rp/shared/editing.ts"
import { Button } from "../../ui/Button.tsx"
import { Field, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { FieldTools, NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import { emptyBook, emptyEntry } from "./lorebookDefaults.ts"
import { type EditorStore, useText, useValue } from "./store.ts"

const BOOK = ["character_book"]
const EMPTY_KEYS: ReadonlyArray<string> = []

/** One key per line: commas in a /pattern/flags key must survive unchanged. */
function Keys({ store, path, label }: { store: EditorStore; path: FieldPath; label: string }) {
  const match = useContext(SearchNavigation)
  const target = useRef<HTMLTextAreaElement>(null)
  const keys = useValue<ReadonlyArray<string>>(store, path) ?? EMPTY_KEYS
  const field = valueField(path)
  const pathKey = JSON.stringify(path)
  useEffect(() => {
    if (!match || JSON.stringify(match.path.slice(0, -1)) !== pathKey) return
    const input = target.current!
    for (let parent = input.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
    }
    const index = Number(match.path.at(-1))
    const offset = keys.slice(0, index).reduce((n, key) => n + key.length + 1, 0)
    const frame = requestAnimationFrame(() => {
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

function Entry({ store, uid, initiallyOpen }: { store: EditorStore; uid: number; initiallyOpen: boolean }) {
  const match = useContext(SearchNavigation)
  const [open, setOpen] = useState(initiallyOpen)
  useEffect(() => {
    if (match?.path[0] !== "character_book" || match.path[2] !== `uid=${uid}`) return
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [match, uid])
  const path = [...BOOK, "entries", `uid=${uid}`]
  const title = useText(store, [...path, "comment"]) || "Untitled entry"
  return (
    <details
      className="rounded-lg border border-border p-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium [overflow-wrap:anywhere]">{title}</summary>
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

/** Registered card section. Every edit uses the card's existing field drafts. */
export function EmbeddedLorebook({ store }: { store: EditorStore }) {
  const book = useValue<LorebookDoc | undefined>(store, BOOK)
  const [addedUid, setAddedUid] = useState<number | null>(null)
  const add = () => {
    // Random safe integer identities avoid reusing the uid of a removed entry or a saved revision.
    let uid: number
    do uid = crypto.getRandomValues(new Uint32Array(1))[0]!
    while (book?.entries.some((entry) => entry.uid === uid))
    const entry: LorebookEntry = emptyEntry(uid)
    setAddedUid(uid)
    if (!book) store.setValue(BOOK, { ...emptyBook(), entries: [entry] })
    else store.setValue([...BOOK, "entries", `uid=${uid}`], entry)
  }
  return (
    <Card>
      <CardHeader
        title="Embedded lorebook"
        description="Travels with this card on export and is used automatically in new chats. Changes are drafts until you save the card."
      />
      <div className="flex min-w-0 flex-col gap-4">
        {book ? (
          <>
            <TextField store={store} path={[...BOOK, "name"]} label="Lorebook name" />
            <TextField store={store} path={[...BOOK, "description"]} label="Lorebook description" rows={3} />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                store={store}
                path={[...BOOK, "scan_depth"]}
                label="Book scan depth (empty follows chat)"
                integer
                nullable
                min={0}
              />
              <NumberField
                store={store}
                path={[...BOOK, "token_budget"]}
                label="Book token budget (empty follows chat)"
                integer
                nullable
                min={0}
              />
            </div>
            <InheritedSwitch store={store} path={[...BOOK, "recursive_scanning"]} label="Recursive scanning" />
            {book.entries.map((entry, index) => (
              <Entry
                key={entry.uid}
                store={store}
                uid={entry.uid}
                initiallyOpen={index === 0 || entry.uid === addedUid}
              />
            ))}
            {book.entries.length === 0 && <p className="text-sm text-muted">No entries yet.</p>}
          </>
        ) : (
          <p className="text-sm text-muted">This card has no embedded lorebook.</p>
        )}
        <div>
          <Button onClick={add}>Add lorebook entry</Button>
        </div>
        <FieldTools store={store} field={valueField(BOOK)} label="Embedded lorebook" />
      </div>
    </Card>
  )
}
