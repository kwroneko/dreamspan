// Everything a lorebook entry holds, as the table's opened row shows it (LorebookTable.tsx):
// its text, keys, matching, group, recursion and timing. Every edit is a field draft.
import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { MultiSelect } from "../../ui/MultiSelect.tsx"
import { useLoreFilterCards } from "./libraryLorebooks.ts"
import { type ReactNode, type RefObject, useContext, useEffect, useRef } from "react"
import { TRIGGERS } from "@rp/shared/presetConditions.ts"
import { type FieldPath, textField, valueField } from "@rp/shared/editing.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Fieldset, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { FieldTools, NumberField, SelectField, SwitchField, TextField, TriggersField } from "./controls.tsx"
import { EXPLAIN } from "./lorebookExplain.ts"
import { entryPath } from "./lorebookTable.ts"
import { SearchNavigation, scrollToSearchField } from "./searchNavigation.ts"
import { type EditorStore, useDirty, useText, useValue } from "./store.ts"

const EMPTY_KEYS: ReadonlyArray<string> = []

/** A search visit to one of these keys: the box focused, the key selected and scrolled to. */
function useKeysReveal(target: RefObject<HTMLTextAreaElement | null>, path: FieldPath, keys: ReadonlyArray<string>) {
  const match = useContext(SearchNavigation)
  const revealed = useRef<typeof match>(null)
  const pathKey = JSON.stringify(path)
  useEffect(() => {
    if (!match || revealed.current === match || JSON.stringify(match.path.slice(0, -1)) !== pathKey) return
    const input = target.current
    if (!input) return
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
  }, [match, pathKey, keys, target])
}

const splitKeys = (text: string) => (text === "" ? [] : text.split("\n"))

/** One key per line: commas in a /pattern/flags key must survive unchanged. */
function Keys({
  store,
  path,
  label,
  description
}: {
  store: EditorStore
  path: FieldPath
  label: string
  description: string
}) {
  const target = useRef<HTMLTextAreaElement>(null)
  const keys = useValue<ReadonlyArray<string>>(store, path) ?? EMPTY_KEYS
  const field = valueField(path)
  useKeysReveal(target, path, keys)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Field label={label} about={description}>
        <Textarea
          ref={target}
          rows={Math.min(4, Math.max(1, keys.length))}
          className="min-h-9!"
          value={keys.join("\n")}
          onChange={(event) => store.setValue(path, splitKeys(event.currentTarget.value))}
          onBlur={() => void store.save(field)}
        />
      </Field>
      <FieldTools store={store} field={field} label={label} />
    </div>
  )
}

/**
 * An opened entry's primary keys under its title (owner, 2026-11-02: "scroll many and read the
 * text, title, trigger words"): one quiet line, the keys separated by commas, until it's clicked
 * or focused; then the box, one key per line, in its place. The box is always there for the
 * keyboard and assistive technology, out of sight until it has focus.
 */
export function KeysLine({
  store,
  path,
  id,
  empty,
  badges
}: {
  store: EditorStore
  path: FieldPath
  id: string
  /** What the line says when there are no keys. */
  empty: string
  /** The entry's chips, after the keys on their line. */
  badges?: ReactNode
}) {
  const target = useRef<HTMLTextAreaElement>(null)
  const keys = useValue<ReadonlyArray<string>>(store, path) ?? EMPTY_KEYS
  const field = valueField(path)
  useKeysReveal(target, path, keys)
  return (
    <div className="group/keys flex min-w-0 flex-col">
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 group-has-[textarea:focus]/keys:hidden">
        <Tooltip label={EXPLAIN.keys_line}>
          {/* The picture of the box below, which is what the keyboard and screen readers reach. */}
          <span
            aria-hidden="true"
            onClick={() => target.current?.focus()}
            className="min-w-0 cursor-text rounded-sm px-2 text-xs break-words text-muted hover:bg-hover hover:text-text"
          >
            {keys.length > 0 ? keys.join(", ") : empty}
          </span>
        </Tooltip>
        {badges}
      </div>
      <Tooltip label={EXPLAIN.keys}>
        <textarea
          ref={target}
          id={id}
          aria-label="Primary keys"
          placeholder="One key per line"
          rows={Math.max(1, keys.length)}
          spellCheck={false}
          className="mt-1 min-h-8 w-full resize-none rounded-md border border-border bg-canvas px-2 py-1 text-sm text-text outline-none field-sizing-content placeholder:text-muted focus-visible:ring-2 focus-visible:ring-focus not-focus:sr-only"
          value={keys.join("\n")}
          onChange={(event) => store.setValue(path, splitKeys(event.currentTarget.value))}
          onBlur={() => void store.save(field)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur()
          }}
        />
      </Tooltip>
      <FieldTools store={store} field={field} label="Primary keys" />
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
      <Field label={label} about={description}>
        <Select
          value={value === null ? "inherit" : String(value)}
          items={[
            { value: "inherit", label: "Default", description: `Not set here: ${fallback}.` },
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
        about="Include it only when another entry’s text matches its keys, rather than the chat alone."
      >
        Delay until recursion
      </Switch>
      {on && (
        <Field
          label="From recursion level"
          about="Wait until this level of matching through other entries. Empty allows any level."
        >
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

/** The existing filter fields, using the library's card and tag choices. */
function CharacterFilter({ store, path }: { store: EditorStore; path: FieldPath }) {
  const filter = useValue<LorebookEntry["character_filter"]>(store, path)
  const current = filter ?? { is_exclude: false, names: [], tags: [] }
  const library = useLoreFilterCards().filter((ref) => ref.refKind === "upstream")
  const chosen = [
    ...(current.cards ?? []).map((card) => card.entity),
    ...current.names.map((name) => `filename:${name}`)
  ]
  const choices = [
    ...library.map((ref) => ({
      value: ref.entityId as string,
      label: ref.label,
      description: `Apply this filter when ${ref.label} writes the reply.`
    })),
    ...(current.cards ?? [])
      .filter((card) => !library.some((ref) => ref.entityId === card.entity))
      .map((card) => ({ value: card.entity, label: card.name, unavailable: true })),
    ...current.names.map((name) => ({ value: `filename:${name}`, label: name, unavailable: true }))
  ]
  const tags = [...new Set([...current.tags, ...library.flatMap((ref) => ref.filterData?.tags ?? [])])].sort()
  const set = (next: typeof current) => {
    store.setValue(
      path,
      !next.is_exclude && next.names.length === 0 && !next.cards?.length && next.tags.length === 0 ? undefined : next
    )
    void store.save(valueField(path))
  }
  return (
    <div className="flex flex-col gap-2">
      <Field
        label="Characters"
        about="Include the entry when a chosen character writes the reply. Empty allows every character."
      >
        <MultiSelect
          items={choices}
          value={chosen}
          addLabel="Add"
          chosenLabel="Chosen characters"
          listLabel="Choose characters"
          explanation="Choose the characters whose replies can include this entry."
          onValueChange={(values) =>
            set({
              ...current,
              names: current.names.filter((name) => values.includes(`filename:${name}`)),
              cards: values
                .filter((value) => !value.startsWith("filename:"))
                .map(
                  (entity) =>
                    current.cards?.find((card) => card.entity === entity) ?? {
                      entity,
                      name:
                        library.find((ref) => ref.entityId === entity)?.filterData?.name ??
                        library.find((ref) => ref.entityId === entity)?.label ??
                        entity
                    }
                )
            })
          }
        />
      </Field>
      <Field label="Character tags" about="Include the entry when the speaker has a chosen tag.">
        <MultiSelect
          items={tags.map((tag) => ({
            value: tag,
            label: tag,
            description: `Apply this filter to characters tagged ${tag}.`
          }))}
          value={current.tags}
          addLabel="Add"
          chosenLabel="Chosen tags"
          listLabel="Choose character tags"
          explanation="Choose tags from the cards in your library."
          onValueChange={(tags) => set({ ...current, tags })}
        />
      </Field>
      <Tooltip label="Exclude the chosen characters and tags from this entry.">
        <Switch checked={current.is_exclude} onCheckedChange={(next) => set({ ...current, is_exclude: next })}>
          Everyone except these
        </Switch>
      </Tooltip>
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
 * An opened entry (owner, 2026-11-01: "only entry content and primary keys should generally be
 * expanded right away"; 2026-11-02: open entries are for scrolling and skimming): its text,
 * sized to it, with no label; its keys are on the header's line (KeysLine). Everything else is
 * its settings, a second level the header's settings button opens above the text, as a preset
 * prompt's options open. `essentials` are the row's own settings where the row doesn't show
 * them (the side panel and narrow screens: strategy, position, depth, order, trigger %).
 */
export function EntryDetails({
  store,
  root,
  uid,
  wide,
  card,
  settings,
  essentials
}: {
  store: EditorStore
  root: FieldPath
  uid: number
  /** The settings in two columns. */
  wide: boolean
  /** A card's embedded book, with the card book's own fields. */
  card: boolean
  /** Its settings are open. */
  settings: boolean
  essentials?: ReactNode
}) {
  const path = entryPath(root, uid)
  const title = useText(store, [...path, "comment"]) || "Untitled entry"
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-x-6 gap-y-1 empty:hidden">
        <RowFieldChange store={store} path={path} label={title} />
        {ROW_FIELDS.map(([at, label]) => (
          <RowFieldChange key={label} store={store} path={[...path, ...at]} label={label} />
        ))}
      </div>
      {settings && <EntrySettings store={store} path={path} wide={wide} card={card} essentials={essentials} />}
      <TextField store={store} path={[...path, "content"]} label="Entry content" labelHidden rows={2} fit />
    </div>
  )
}

/** Everything about an entry but its title, keys and text, opened from its header. */
function EntrySettings({
  store,
  path,
  wide,
  card,
  essentials
}: {
  store: EditorStore
  path: FieldPath
  wide: boolean
  card: boolean
  essentials?: ReactNode
}) {
  const position = useValue<string>(store, [...path, "position"])
  const selective = useValue<boolean>(store, [...path, "selective"])
  return (
    <section aria-label="Entry settings" className="min-w-0 rounded-lg border border-border bg-surface-raised/50">
      <div className="flex min-w-0 flex-col gap-4 p-3">
        {essentials}
        <div className={`grid min-w-0 gap-4 ${wide ? "grid-cols-2" : ""}`}>
          <div className="flex min-w-0 flex-col gap-4">
            <section className={group} aria-label="Secondary keys">
              <SwitchField
                store={store}
                path={[...path, "selective"]}
                label="Use secondary keys"
                about={EXPLAIN.selective}
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
                  <Keys
                    store={store}
                    path={[...path, "secondary_keys"]}
                    label="Secondary keys"
                    description={EXPLAIN.secondary_keys}
                  />
                </>
              )}
            </section>
            {position === "outlet" && (
              <TextField
                store={store}
                path={[...path, "outlet_name"]}
                label="Outlet name"
                about={EXPLAIN.outlet_name}
              />
            )}
            <section className={group} aria-label="Matching">
              <h4 className={groupTitle}>Matching</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <InheritedSwitch
                  store={store}
                  path={[...path, "case_sensitive"]}
                  label="Case sensitive"
                  fallback="off"
                  description={EXPLAIN.case_sensitive}
                />
                <InheritedSwitch
                  store={store}
                  path={[...path, "match_whole_words"]}
                  label="Whole words"
                  fallback="on"
                  description={EXPLAIN.match_whole_words}
                />
              </div>
              <NumberField
                store={store}
                path={[...path, "scan_depth"]}
                label="Scan depth"
                about="Check this many recent messages for keys. Empty uses the book’s setting, or 2."
                integer
                nullable
                min={0}
              />
              <Fieldset legend="Also look for keys in">
                {MATCH_SOURCES.map(([key, label]) => (
                  <SwitchField key={key} store={store} path={[...path, key]} label={label} checkbox />
                ))}
              </Fieldset>
              <TriggersField
                store={store}
                path={[...path, "triggers"]}
                label="Generation types (none ticked: all)"
                items={TRIGGERS}
              />
            </section>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <section className={group} aria-label="Inclusion group">
              <h4 className={groupTitle}>Inclusion group</h4>
              <TextField store={store} path={[...path, "group"]} label="Group" about={EXPLAIN.group} />
              <SwitchField
                store={store}
                path={[...path, "group_override"]}
                label="Prioritize this entry in its group"
                about={EXPLAIN.group_override}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  store={store}
                  path={[...path, "group_weight"]}
                  label="Group weight"
                  min={0}
                  about={EXPLAIN.group_weight}
                />
                <InheritedSwitch
                  store={store}
                  path={[...path, "use_group_scoring"]}
                  label="Group scoring"
                  fallback="off"
                  description={EXPLAIN.use_group_scoring}
                />
              </div>
            </section>
            <section className={group} aria-label="Recursion and budget">
              <h4 className={groupTitle}>Recursion and budget</h4>
              <SwitchField
                store={store}
                path={[...path, "exclude_recursion"]}
                label="Non-recursable"
                about="Other entries' text can't trigger it."
              />
              <SwitchField
                store={store}
                path={[...path, "prevent_recursion"]}
                label="Prevent further recursion"
                about="Its text doesn't trigger other entries."
              />
              <DelayUntilRecursion store={store} path={[...path, "delay_until_recursion"]} />
              <SwitchField
                store={store}
                path={[...path, "ignore_budget"]}
                label="Ignore the token budget"
                about="Still included once the lorebook budget, or this book's own, is used up. Its text still counts toward them."
              />
              <SwitchField
                store={store}
                path={[...path, "use_probability"]}
                label="Use the trigger %"
                about="Off, a match always includes it."
              />
            </section>
            <details className={group}>
              <summary className={`cursor-pointer ${groupTitle}`}>Timing, filters and automation</summary>
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField
                  store={store}
                  path={[...path, "sticky"]}
                  label="Sticky"
                  integer
                  nullable
                  min={0}
                  about="Keep the entry included for this many messages after a match."
                />
                <NumberField
                  store={store}
                  path={[...path, "cooldown"]}
                  label="Cooldown"
                  integer
                  nullable
                  min={0}
                  about="Wait this many messages after the entry stops before allowing another match."
                />
                <NumberField
                  store={store}
                  path={[...path, "delay"]}
                  label="Delay"
                  integer
                  nullable
                  min={0}
                  about="Not included until the chat has this many messages."
                />
              </div>
              <CharacterFilter store={store} path={[...path, "character_filter"]} />
              <TextField
                store={store}
                path={[...path, "automation_id"]}
                label="Automation ID"
                about="Run this automation when the entry is included. Kept for export; nothing runs here yet."
              />
              <SwitchField
                store={store}
                path={[...path, "add_memo"]}
                label="Add the title as a memo"
                about="Kept for export. It changes nothing sent to the model."
              />
              {card && (
                <>
                  <TextField
                    store={store}
                    path={[...path, "name"]}
                    label="Name in exports"
                    about="The entry's name in an exported card."
                  />
                  <NumberField
                    store={store}
                    path={[...path, "priority"]}
                    label="Priority in exports"
                    about="The entry's priority in an exported card. Order decides here."
                    optional
                  />
                  <SwitchField
                    store={store}
                    path={[...path, "use_regex"]}
                    label="Keys are regular expressions"
                    about="Kept for export. Keys here are regular expressions when written as /pattern/flags."
                  />
                </>
              )}
            </details>
          </div>
        </div>
      </div>
    </section>
  )
}
