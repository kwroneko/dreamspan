import { FieldRevert, linesText } from "./FieldRevert.tsx"
// Everything a lorebook entry holds, as the table's opened row shows it (LorebookTable.tsx):
// its text, then its settings form (lorebookSettings.ts). Every edit is a field draft.
import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import type { Registry } from "../../registry.ts"
import { BlockSection } from "../../ui/Block.tsx"
import { MultiSelect } from "../../ui/MultiSelect.tsx"
import { useLoreFilterCards } from "./libraryLorebooks.ts"
import { type FieldPath, textField, valueField } from "@rp/shared/editing.ts"
import { useEditorFocus } from "../../textActions.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Fieldset, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { FieldTools, NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import {
  changed,
  formSections,
  type LorebookEntrySection,
  lorebookEntrySections,
  type LorebookEntrySetting,
  lorebookEntrySettings,
  sectionSummary
} from "./lorebookSettings.ts"
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
export function Keys({
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
          tools={
            <FieldRevert
              store={store}
              path={path}
              value={keys.join("\n")}
              field={field}
              format={linesText}
              onChange={(value) => store.setValue(path, splitKeys(value))}
            />
          }
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
  // A press on a later entry must finish before this box folds and moves that entry.
  const { focused, onFocus, onBlur } = useEditorFocus()
  const target = useRef<HTMLTextAreaElement>(null)
  const keys = useValue<ReadonlyArray<string>>(store, path) ?? EMPTY_KEYS
  const field = valueField(path)
  useKeysReveal(target, path, keys)
  return (
    <div className="group/keys flex min-w-0 flex-col">
      <div
        className={`mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 group-focus-within/keys:hidden ${focused ? "hidden" : ""}`}
      >
        <Tooltip label={EXPLAIN.keys_line}>
          {/* The picture of the box below, which is what the keyboard and screen readers reach. */}
          <span
            aria-hidden="true"
            data-own-click
            onClick={() => target.current?.focus()}
            className="min-w-0 cursor-text rounded-sm px-2 text-xs break-words text-muted hover:bg-hover hover:text-text"
          >
            {keys.length > 0 ? keys.join(", ") : empty}
          </span>
        </Tooltip>
        {badges}
      </div>
      <div onFocus={onFocus} onBlur={onBlur} className={focused ? "" : "not-focus-within:sr-only"}>
        <Textarea
          ref={target}
          id={id}
          aria-label="Primary keys"
          placeholder="One key per line"
          rows={Math.max(1, keys.length)}
          spellCheck={false}
          className="min-h-8! resize-none field-sizing-content"
          textActions={false}
          value={keys.join("\n")}
          tools={
            <FieldRevert
              store={store}
              path={path}
              value={keys.join("\n")}
              field={field}
              format={linesText}
              onChange={(value) => store.setValue(path, splitKeys(value))}
            />
          }
          onChange={(event) => store.setValue(path, splitKeys(event.currentTarget.value))}
          onBlur={() => {
            void store.save(field)
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.blur()
            }
          }}
        />
      </div>
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
export function DelayUntilRecursion({ store, path }: { store: EditorStore; path: FieldPath }) {
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
export function CharacterFilter({ store, path }: { store: EditorStore; path: FieldPath }) {
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

/**
 * An opened entry (owner, 2026-11-01: "only entry content and primary keys should generally be
 * expanded right away"; 2026-11-02: open entries are for scrolling and skimming, and the text
 * comes right after the keys): its text, sized to it, with no label; its keys are on the
 * header's line (KeysLine). Its settings, which the header's settings button opens, come below
 * the text (EntrySettings). `essentials` are the row's own settings where the row doesn't show
 * them (the side panel and narrow screens: strategy, position, depth, order, trigger %).
 */
export function EntryDetails({
  store,
  root,
  uid,
  wide,
  compact,
  card,
  settings,
  essentials
}: {
  store: EditorStore
  root: FieldPath
  uid: number
  /** The settings in two open columns (the large editor); otherwise accordions. */
  wide: boolean
  /** The row hides its columns: they're in the settings' first section. */
  compact: boolean
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
      <TextField store={store} path={[...path, "content"]} label="Entry content" labelHidden rows={2} fit />
      {settings && (
        <EntrySettings
          store={store}
          path={path}
          title={title}
          wide={wide}
          compact={compact}
          card={card}
          essentials={essentials}
        />
      )}
    </div>
  )
}

const useRegistry = <A extends { readonly id: string; readonly order: number }>(registry: Registry<A>) => {
  const snapshot = useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot)
  return [...snapshot.entries].sort((a, b) => a.order - b.order)
}

/** The form's sections and their settings, from the registries. */
export const useFormSections = (options: { card: boolean; many: boolean }) =>
  formSections(useRegistry(lorebookEntrySections), useRegistry(lorebookEntrySettings), options)

export type FormSection = ReturnType<typeof formSections>[number]

/** Settings in a row sharing a `group` (the places keys are also looked for) under one heading. */
function Grouped({
  settings,
  render
}: {
  settings: ReadonlyArray<LorebookEntrySetting>
  render: (setting: LorebookEntrySetting) => ReactNode
}) {
  const runs: Array<{ group?: string; settings: Array<LorebookEntrySetting> }> = []
  for (const setting of settings) {
    const last = runs.at(-1)
    if (setting.group && last?.group === setting.group) last.settings.push(setting)
    else runs.push({ ...(setting.group ? { group: setting.group } : {}), settings: [setting] })
  }
  return (
    <>
      {runs.map((run) =>
        run.group ? (
          <Fieldset key={run.settings[0]!.id} legend={run.group}>
            {run.settings.map((setting) => (
              <Fragment key={setting.id}>{render(setting)}</Fragment>
            ))}
          </Fieldset>
        ) : (
          <Fragment key={run.settings[0]!.id}>{render(run.settings[0]!)}</Fragment>
        )
      )}
    </>
  )
}

/**
 * The settings form's layout, for one entry or many (LorebookMassEdit): accordions, closed until
 * opened, each with its one-line summary and a dot when it differs from the defaults (the side
 * panel, owner 2026-11-02: "expanding settings blows up the sidebar entry"), or every section
 * open in two columns (the large editor and a wide dialog).
 */
export function SettingsLayout({
  sections,
  accordion,
  wide,
  label,
  render,
  lead,
  summary,
  differs
}: {
  sections: ReadonlyArray<FormSection>
  accordion: boolean
  wide: boolean
  /** Whose settings, for the sections' accessible names: "Matching of <label>". */
  label: string
  render: (setting: LorebookEntrySetting) => ReactNode
  /** What a section shows before its fields (the row's columns). */
  lead?: (section: LorebookEntrySection) => ReactNode
  summary?: (section: FormSection) => string
  differs?: (section: FormSection) => boolean
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const body = (item: FormSection) => (
    <div className="flex min-w-0 flex-col gap-4">
      {lead?.(item.section)}
      <Grouped settings={item.settings} render={render} />
    </div>
  )
  if (accordion)
    return (
      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface [&>:first-child]:border-t-0">
        {sections.map((item) => (
          <BlockSection
            key={item.section.id}
            open={open.has(item.section.id)}
            onToggle={() =>
              setOpen((set) => {
                const next = new Set(set)
                if (!next.delete(item.section.id)) next.add(item.section.id)
                return next
              })
            }
            title={item.section.title}
            summary={open.has(item.section.id) ? undefined : summary?.(item)}
            changed={differs?.(item) ?? false}
            hint={item.section.hint}
            label={label}
          >
            {open.has(item.section.id) && body(item)}
          </BlockSection>
        ))}
      </div>
    )
  const column = (index: 0 | 1) =>
    sections
      .filter((item) => !wide || item.section.column === index)
      .map((item) => (
        <section
          key={item.section.id}
          aria-label={item.section.title}
          className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-3"
        >
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            {item.section.title}
            {differs?.(item) && (
              <span data-changed aria-label="changed from the defaults" className="size-1.5 rounded-full bg-accent" />
            )}
          </h4>
          {body(item)}
        </section>
      ))
  return (
    <div className={`grid min-w-0 gap-4 ${wide ? "grid-cols-2" : ""}`}>
      <div className="flex min-w-0 flex-col gap-4">{column(0)}</div>
      {wide && <div className="flex min-w-0 flex-col gap-4">{column(1)}</div>}
    </div>
  )
}

/** One entry's setting, as its own control bound to the entry's field. */
function SingleSetting({
  store,
  path,
  setting
}: {
  store: EditorStore
  path: FieldPath
  setting: LorebookEntrySetting
}) {
  if (setting.single) return <setting.single store={store} path={path} setting={setting} />
  const at = [...path, setting.field ?? setting.id]
  const input = setting.input
  switch (input.kind) {
    case "switch":
      return (
        <SwitchField
          store={store}
          path={at}
          label={setting.label}
          about={setting.description}
          checkbox={!!setting.group}
        />
      )
    case "inherit":
      return (
        <InheritedSwitch
          store={store}
          path={at}
          label={setting.label}
          fallback={input.fallback}
          description={setting.description}
        />
      )
    case "choice":
      return (
        <SelectField store={store} path={at} label={setting.label} about={setting.description} items={input.options} />
      )
    case "number":
      return (
        <NumberField
          store={store}
          path={at}
          label={setting.label}
          about={setting.description}
          integer={input.integer ?? false}
          nullable={input.nullable ?? false}
          {...(input.min === undefined ? {} : { min: input.min })}
          {...(input.max === undefined ? {} : { max: input.max })}
        />
      )
    case "text":
      return <TextField store={store} path={at} label={setting.label} about={setting.description} />
  }
}

/** Everything about an entry but its title, keys and text, opened from its header. */
function EntrySettings({
  store,
  path,
  title,
  wide,
  compact,
  card,
  essentials
}: {
  store: EditorStore
  path: FieldPath
  title: string
  wide: boolean
  compact: boolean
  card: boolean
  essentials?: ReactNode
}) {
  const entry = useValue<LorebookEntry | undefined>(store, path)
  const all = useFormSections({ card, many: false })
  if (!entry) return null
  const sections = all
    .filter((item) => item.section.visible?.(entry, compact) ?? true)
    .map((item) => ({ ...item, settings: item.settings.filter((setting) => setting.visible?.(entry) ?? true) }))
  return (
    <section aria-label="Entry settings" className="min-w-0">
      <SettingsLayout
        sections={sections}
        accordion={!wide}
        wide={wide}
        label={title}
        render={(setting) => <SingleSetting store={store} path={path} setting={setting} />}
        lead={(section) =>
          section.lead ? <section.lead store={store} path={path} entry={entry} essentials={essentials} /> : null
        }
        summary={(item) => sectionSummary(item.settings, entry)}
        differs={(item) => item.settings.some((setting) => changed(setting, entry))}
      />
    </section>
  )
}
