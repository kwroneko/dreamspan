// Everything a lorebook entry holds, as the table's opened row shows it (LorebookTable.tsx):
// its text, keys, matching, group, recursion and timing. Every edit is a field draft.
import { useContext, useEffect, useRef } from "react"
import { TRIGGERS } from "@rp/shared/presetConditions.ts"
import { type FieldPath, textField, valueField } from "@rp/shared/editing.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { FieldTools, NumberField, SelectField, SwitchField, TextField, TriggersField } from "./controls.tsx"
import { entryPath } from "./lorebookTable.ts"
import { SearchNavigation, scrollToSearchField } from "./searchNavigation.ts"
import { type EditorStore, useDirty, useText, useValue } from "./store.ts"

const EMPTY_KEYS: ReadonlyArray<string> = []

/** One key per line: commas in a /pattern/flags key must survive unchanged. */
function Keys({ store, path, label, id }: { store: EditorStore; path: FieldPath; label: string; id?: string }) {
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
          id={id}
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

/**
 * Null is unset: chats use ST's default (`fallback`), and a file keeps it unset; an imported
 * explicit false must remain distinct.
 */
export function InheritedSwitch({
  store,
  path,
  label,
  fallback,
  description
}: {
  store: EditorStore
  path: FieldPath
  label: string
  /** What chats do when it's unset. */
  fallback: "on" | "off"
  description?: string
}) {
  const value = useValue<boolean | null>(store, path)
  return (
    <div className="flex flex-col gap-1">
      <Field label={label} description={description}>
        <Select
          value={value === null ? "inherit" : String(value)}
          items={[
            { value: "inherit", label: "Default", description: `Not set here: ${fallback}, as in a fresh ST install.` },
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

/** ST's "delay until recursion": off, any recursion step, or from a given level on. */
function DelayUntilRecursion({ store, path }: { store: EditorStore; path: FieldPath }) {
  const value = useValue<boolean | number>(store, path)
  const on = value !== false && value !== 0
  return (
    <div className="flex flex-col gap-2">
      <Switch
        checked={on}
        onCheckedChange={(next) => store.setValue(path, next)}
        description="Matched only once recursion has started: from another entry's text, not the chat."
      >
        Delay until recursion
      </Switch>
      {on && (
        <Field label="From recursion level (empty: any)">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={typeof value === "number" ? String(value) : ""}
            onChange={(event) => {
              const text = event.currentTarget.value
              const level = Number(text)
              if (text.trim() === "") store.setValue(path, true)
              else if (Number.isInteger(level) && level >= 1) store.setValue(path, level)
            }}
            onBlur={() => void store.save(valueField(path))}
          />
        </Field>
      )}
      <FieldTools store={store} field={valueField(path)} label="Delay until recursion" />
    </div>
  )
}

/** A list of names, one per line, as an optional object's field. */
function CharacterFilter({ store, path }: { store: EditorStore; path: FieldPath }) {
  const filter = useValue<
    { is_exclude: boolean; names: ReadonlyArray<string>; tags: ReadonlyArray<string> } | undefined
  >(store, path)
  const current = filter ?? { is_exclude: false, names: [], tags: [] }
  const set = (next: typeof current) =>
    store.setValue(path, !next.is_exclude && next.names.length === 0 && next.tags.length === 0 ? undefined : next)
  const lines = (text: string) => (text === "" ? [] : text.split("\n"))
  return (
    <div className="flex flex-col gap-2">
      <Field label="Characters" description="One name per line. Empty: every character.">
        <Textarea
          rows={2}
          value={current.names.join("\n")}
          onChange={(event) => set({ ...current, names: lines(event.currentTarget.value) })}
          onBlur={() => void store.save(valueField(path))}
        />
      </Field>
      <Field label="Character tags" description="One tag per line.">
        <Textarea
          rows={2}
          value={current.tags.join("\n")}
          onChange={(event) => set({ ...current, tags: lines(event.currentTarget.value) })}
          onBlur={() => void store.save(valueField(path))}
        />
      </Field>
      <Switch checked={current.is_exclude} onCheckedChange={(next) => set({ ...current, is_exclude: next })}>
        Everyone except these
      </Switch>
      <FieldTools store={store} field={valueField(path)} label="Character filter" />
    </div>
  )
}

const MATCH_SOURCES = [
  ["match_persona_description", "Persona description"],
  ["match_character_description", "Character description"],
  ["match_character_personality", "Personality"],
  ["match_character_depth_prompt", "Character's note"],
  ["match_scenario", "Scenario"],
  ["match_creator_notes", "Creator's notes"]
] as const

/** The row's own fields, edited in the table: their Undo, History and Revert, while changed. */
const ROW_FIELDS = [
  [["comment"], "Title"],
  [["enabled"], "Enabled"],
  [["constant"], "Strategy (constant)"],
  [["vectorized"], "Strategy (vectorized)"],
  [["position"], "Position"],
  [["role"], "Position (role)"],
  [["depth"], "Depth"],
  [["order"], "Order"],
  [["probability"], "Trigger %"]
] as const

function RowFieldChange({ store, path, label }: { store: EditorStore; path: FieldPath; label: string }) {
  const key = path.at(-1) === "comment" ? textField(path) : valueField(path)
  const dirty = useDirty(store, key)
  if (!dirty) return null
  return (
    <div className="flex flex-wrap items-center gap-x-2">
      <span className="text-sm text-muted">{label}:</span>
      <FieldTools store={store} field={key} label={label} />
    </div>
  )
}

const group = "flex flex-col gap-4 rounded-lg border border-border p-3"
const groupTitle = "text-sm font-medium"

/**
 * Everything an entry holds besides what its row shows: its text, keys, matching, group,
 * recursion and timing, and the fields only SillyTavern or a card book uses.
 */
export function EntryDetails({
  store,
  root,
  uid,
  wide,
  card
}: {
  store: EditorStore
  root: FieldPath
  uid: number
  /** Two columns side by side. */
  wide: boolean
  /** A card's embedded book, with the card book's own fields. */
  card: boolean
}) {
  const path = entryPath(root, uid)
  const title = useText(store, [...path, "comment"]) || "Untitled entry"
  const position = useValue<string>(store, [...path, "position"])
  const selective = useValue<boolean>(store, [...path, "selective"])
  return (
    <div role="group" aria-label={`Lorebook entry ${uid}`} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 empty:hidden">
        <RowFieldChange store={store} path={path} label={title} />
        {ROW_FIELDS.map(([at, label]) => (
          <RowFieldChange key={label} store={store} path={[...path, ...at]} label={label} />
        ))}
      </div>
      <div className={`grid min-w-0 gap-4 ${wide ? "grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : ""}`}>
        <div className="flex min-w-0 flex-col gap-4">
          <TextField store={store} path={[...path, "content"]} label="Entry content" rows={8} expandable />
          <Keys store={store} path={[...path, "keys"]} label="Primary keys" id={`lore-keys-${uid}`} />
          <section className={group} aria-label="Secondary keys">
            <SwitchField
              store={store}
              path={[...path, "selective"]}
              label="Use secondary keys"
              description="A primary key match also has to pass this filter."
            />
            {selective && (
              <>
                <SelectField
                  store={store}
                  path={[...path, "selective_logic"]}
                  label="Logic"
                  items={[
                    { value: "and_any", label: "AND ANY", description: "At least one secondary key also appears." },
                    { value: "and_all", label: "AND ALL", description: "Every secondary key also appears." },
                    { value: "not_any", label: "NOT ANY", description: "None of the secondary keys appears." },
                    { value: "not_all", label: "NOT ALL", description: "At least one secondary key is missing." }
                  ]}
                />
                <Keys store={store} path={[...path, "secondary_keys"]} label="Secondary keys" />
              </>
            )}
          </section>
          {position === "outlet" && (
            <TextField
              store={store}
              path={[...path, "outlet_name"]}
              label="Outlet name"
              description="Sent where a prompt has {{outlet::this name}}."
            />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <section className={group} aria-label="Matching">
            <h4 className={groupTitle}>Matching</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <InheritedSwitch store={store} path={[...path, "case_sensitive"]} label="Case sensitive" fallback="off" />
              <InheritedSwitch store={store} path={[...path, "match_whole_words"]} label="Whole words" fallback="on" />
            </div>
            <NumberField
              store={store}
              path={[...path, "scan_depth"]}
              label="Scan depth (empty follows the chat)"
              integer
              nullable
              min={0}
            />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm">Also look for keys in</legend>
              {MATCH_SOURCES.map(([key, label]) => (
                <SwitchField key={key} store={store} path={[...path, key]} label={label} checkbox />
              ))}
            </fieldset>
            <TriggersField
              store={store}
              path={[...path, "triggers"]}
              label="Generation types (none ticked: all)"
              items={TRIGGERS}
            />
          </section>
          <section className={group} aria-label="Inclusion group">
            <h4 className={groupTitle}>Inclusion group</h4>
            <TextField
              store={store}
              path={[...path, "group"]}
              label="Group"
              description="Of the entries in one group that match, only one is sent."
            />
            <SwitchField
              store={store}
              path={[...path, "group_override"]}
              label="Prioritize this entry in its group"
              description="When several of its group match, this one is chosen."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                store={store}
                path={[...path, "group_weight"]}
                label="Group weight"
                min={0}
                description="In ST, its chance of being the one chosen. Chats here don't choose by weight."
              />
              <InheritedSwitch
                store={store}
                path={[...path, "use_group_scoring"]}
                label="Group scoring"
                fallback="off"
                description="Of its group's matches, only those with the most keys found can be chosen."
              />
            </div>
          </section>
          <section className={group} aria-label="Recursion and budget">
            <h4 className={groupTitle}>Recursion and budget</h4>
            <SwitchField
              store={store}
              path={[...path, "exclude_recursion"]}
              label="Non-recursable"
              description="Other entries' text can't trigger it."
            />
            <SwitchField
              store={store}
              path={[...path, "prevent_recursion"]}
              label="Prevent further recursion"
              description="Its text doesn't trigger other entries."
            />
            <DelayUntilRecursion store={store} path={[...path, "delay_until_recursion"]} />
            <SwitchField
              store={store}
              path={[...path, "ignore_budget"]}
              label="Ignore the token budget"
              description="Still included once the lorebook budget (a quarter of the context, less the reply's room) or this book's own is used up; its text still counts toward them. With entries below the history it still has to fit the room kept for them."
            />
            <SwitchField
              store={store}
              path={[...path, "use_probability"]}
              label="Use the trigger %"
              description="Off, a match always includes it."
            />
          </section>
          <details className={group}>
            <summary className={`cursor-pointer ${groupTitle}`}>Timing, filters and automation</summary>
            <p className="text-sm text-muted">
              Kept as SillyTavern has them. Chats here don't use sticky, cooldown, character filters or automation yet;
              the context inspector lists an entry that has them.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField
                store={store}
                path={[...path, "sticky"]}
                label="Sticky"
                integer
                nullable
                min={0}
                description="Messages it stays in for after it triggers."
              />
              <NumberField
                store={store}
                path={[...path, "cooldown"]}
                label="Cooldown"
                integer
                nullable
                min={0}
                description="Messages it can't trigger again for, after it's been in."
              />
              <NumberField
                store={store}
                path={[...path, "delay"]}
                label="Delay"
                integer
                nullable
                min={0}
                description="Not included until the chat has this many messages."
              />
            </div>
            <CharacterFilter store={store} path={[...path, "character_filter"]} />
            <TextField store={store} path={[...path, "automation_id"]} label="Automation ID" />
            <SwitchField
              store={store}
              path={[...path, "add_memo"]}
              label="Add the title as a memo"
              description="SillyTavern's flag, which its imports set when an entry has a title. Nothing here reads it and it changes nothing sent to the model; it's kept for exports."
            />
            {card && (
              <>
                <TextField store={store} path={[...path, "name"]} label="Name (card books)" />
                <NumberField store={store} path={[...path, "priority"]} label="Priority (card books)" optional />
                <SwitchField store={store} path={[...path, "use_regex"]} label="Keys are regular expressions" />
              </>
            )}
          </details>
        </div>
      </div>
    </div>
  )
}
