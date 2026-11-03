// The lorebook entry form's default sections and settings (lorebookSettings.ts): what one
// entry's settings show, and what "Edit N entries" can change on several at once.
import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { TRIGGERS } from "@rp/shared/presetConditions.ts"
import { NumberField, TextField, TriggersField } from "./controls.tsx"
import { emptyEntry } from "./lorebookDefaults.ts"
import { CharacterFilter, DelayUntilRecursion, Keys } from "./LorebookEntryDetails.tsx"
import { EXPLAIN } from "./lorebookExplain.ts"
import {
  type LorebookEntrySection,
  lorebookEntrySections,
  type LorebookEntrySetting,
  lorebookEntrySettings,
  type MassValue,
  type SingleSectionProps
} from "./lorebookSettings.ts"
import { POSITIONS, positionValue, strategyOf } from "./lorebookTable.ts"

type Setting = Omit<LorebookEntrySetting, "order">
type Section = Omit<LorebookEntrySection, "order">

const DEFAULT = emptyEntry(0)

const flag = (
  section: string,
  id: keyof LorebookEntry & string,
  label: string,
  description: string,
  extra: Partial<Setting> = {}
): Setting => ({
  section,
  id,
  field: id,
  label,
  description,
  input: { kind: "switch" },
  current: (entry) => Boolean(entry[id]),
  patch: (value) => ({ [id]: value === true }),
  ...extra
})

const number = (
  section: string,
  id: "depth" | "order" | "group_weight" | "scan_depth" | "sticky" | "cooldown" | "delay",
  label: string,
  description: string,
  options: { min?: number; max?: number; integer?: boolean; nullable?: boolean } = {}
): Setting => ({
  section,
  id,
  field: id,
  label,
  description,
  input: { kind: "number", ...options },
  current: (entry) => entry[id],
  // Cleared: unset where it can be, else a new entry's value.
  patch: (value) => ({
    [id]: value === null || value === "" ? (options.nullable ? null : DEFAULT[id]) : Number(value)
  })
})

/** A setting that's unset (null: the default applies), on or off. */
const inherited = (
  section: string,
  id: "case_sensitive" | "match_whole_words" | "use_group_scoring",
  label: string,
  description: string,
  fallback: "on" | "off"
): Setting => ({
  section,
  id,
  field: id,
  label,
  description,
  input: { kind: "inherit", fallback },
  current: (entry) => (entry[id] === null ? "inherit" : String(entry[id])),
  patch: (value) => ({ [id]: value === "inherit" || value === null ? null : value === "true" })
})

const LOGIC = [
  { value: "and_any", label: "AND ANY", description: "At least one secondary key also appears." },
  { value: "and_all", label: "AND ALL", description: "Every secondary key also appears." },
  { value: "not_any", label: "NOT ANY", description: "None of the secondary keys appears." },
  { value: "not_all", label: "NOT ALL", description: "At least one secondary key is missing." }
]

const MATCH_SOURCES = [
  ["match_persona_description", "Persona description"],
  ["match_character_description", "Character description"],
  ["match_character_personality", "Personality"],
  ["match_character_depth_prompt", "Character's note"],
  ["match_scenario", "Scenario"],
  ["match_creator_notes", "Creator's notes"]
] as const

/** The row's columns, where the row doesn't show them (the side panel, a narrow screen). */
const Essentials = ({ essentials }: SingleSectionProps) => <>{essentials}</>

const SECTIONS: ReadonlyArray<Section> = [
  {
    id: "activation",
    title: "Strategy and position",
    hint: "When the entry is included, where its text goes, and its order.",
    column: 0,
    // The large editor's rows show these as columns; the outlet's name stays here.
    visible: (entry, compact) => compact || entry.position === "outlet",
    lead: Essentials
  },
  {
    id: "secondary",
    title: "Secondary keys",
    hint: "Keys that also have to appear, or must not, after a primary key matched.",
    column: 0
  },
  {
    id: "matching",
    title: "Matching",
    hint: "How and where the keys are looked for.",
    column: 0
  },
  {
    id: "group",
    title: "Inclusion group",
    hint: "Entries in one group compete: only one of those that match is included.",
    column: 1
  },
  {
    id: "recursion",
    title: "Recursion and budget",
    hint: "Whether other entries' text can include it, and the token budget.",
    column: 1
  },
  {
    id: "timing",
    title: "Timing and filters",
    hint: "How long it stays included, and for which characters.",
    column: 1
  },
  {
    id: "export",
    title: "Card export only",
    hint: "Settings kept for exporting the lorebook or card. They change nothing in chats here.",
    column: 1
  }
]

const SETTINGS: ReadonlyArray<Setting> = [
  // In the row's own columns; listed so several entries can change them.
  flag("activation", "enabled", "Enabled", EXPLAIN.enabled, { single: () => null }),
  {
    section: "activation",
    id: "strategy",
    label: "Strategy",
    description: EXPLAIN.strategy,
    input: {
      kind: "choice",
      options: [
        { value: "normal", label: "Normal", description: EXPLAIN.normal },
        { value: "constant", label: "Constant", description: EXPLAIN.constant },
        { value: "vectorized", label: "Vectorized", description: EXPLAIN.vectorized }
      ]
    },
    current: strategyOf,
    patch: (value: MassValue) => ({ constant: value === "constant", vectorized: value === "vectorized" }),
    single: () => null
  },
  {
    section: "activation",
    id: "position",
    label: "Position",
    description: EXPLAIN.position,
    input: {
      kind: "choice",
      options: POSITIONS.map((item) => ({ value: item.value, label: item.label, description: item.description }))
    },
    current: positionValue,
    patch: (value: MassValue) => {
      const picked = POSITIONS.find((item) => item.value === value) ?? POSITIONS[0]!
      return picked.role ? { position: picked.position, role: picked.role } : { position: picked.position }
    },
    single: () => null
  },
  { ...number("activation", "depth", "Depth", EXPLAIN.depth, { min: 0, integer: true }), single: () => null },
  { ...number("activation", "order", "Order", EXPLAIN.order), single: () => null },
  {
    section: "activation",
    id: "probability",
    label: "Trigger %",
    description: `${EXPLAIN.probability} Setting it also turns “Use the trigger %” on.`,
    input: { kind: "number", min: 0, max: 100, integer: true },
    current: (entry) => entry.probability,
    patch: (value: MassValue) => ({
      probability: value === null || value === "" ? DEFAULT.probability : Number(value),
      use_probability: true
    }),
    single: () => null,
    summary: (value) => `${String(value)}%`
  },
  {
    section: "activation",
    id: "outlet_name",
    field: "outlet_name",
    label: "Outlet name",
    description: EXPLAIN.outlet_name,
    input: { kind: "text" },
    current: (entry) => entry.outlet_name,
    patch: (value) => ({ outlet_name: String(value ?? "") }),
    visible: (entry) => entry.position === "outlet"
  },
  flag("secondary", "selective", "Use secondary keys", EXPLAIN.selective, {
    summary: (value) => (value === true ? "On" : "Off")
  }),
  {
    section: "secondary",
    id: "selective_logic",
    field: "selective_logic",
    label: "Logic",
    description: EXPLAIN.selective_logic,
    input: { kind: "choice", options: LOGIC },
    current: (entry) => entry.selective_logic,
    patch: (value: MassValue) => ({ selective_logic: value as LorebookEntry["selective_logic"] }),
    visible: (entry) => entry.selective,
    summary: (value) => LOGIC.find((item) => item.value === value)?.label ?? String(value)
  },
  {
    section: "secondary",
    id: "secondary_keys",
    label: "Secondary keys",
    description: EXPLAIN.secondary_keys,
    input: { kind: "text" },
    current: (entry) => entry.secondary_keys.join(", "),
    patch: () => ({}),
    many: false,
    visible: (entry) => entry.selective,
    single: ({ store, path, setting }) => (
      <Keys store={store} path={[...path, "secondary_keys"]} label={setting.label} description={setting.description} />
    ),
    summary: (value) => String(value)
  },
  inherited("matching", "case_sensitive", "Case sensitive", EXPLAIN.case_sensitive, "off"),
  inherited("matching", "match_whole_words", "Whole words", EXPLAIN.match_whole_words, "on"),
  number("matching", "scan_depth", "Scan depth", EXPLAIN.scan_depth, { min: 0, integer: true, nullable: true }),
  ...MATCH_SOURCES.map(([id, label]) =>
    flag("matching", id, label, EXPLAIN.match_sources, { group: "Also look for keys in" })
  ),
  {
    section: "matching",
    id: "triggers",
    label: "Generation types",
    description: EXPLAIN.triggers,
    input: { kind: "text" },
    current: (entry) => entry.triggers.join(", "),
    patch: () => ({}),
    many: false,
    single: ({ store, path }) => (
      <TriggersField
        store={store}
        path={[...path, "triggers"]}
        label="Generation types (none ticked: all)"
        items={TRIGGERS}
      />
    ),
    summary: (value) => `Only ${String(value)}`
  },
  {
    section: "group",
    id: "group",
    field: "group",
    label: "Group",
    description: EXPLAIN.group,
    input: { kind: "text" },
    current: (entry) => entry.group,
    patch: (value: MassValue) => ({ group: String(value ?? "") }),
    summary: (value) => String(value)
  },
  flag("group", "group_override", "Prioritize this entry in its group", EXPLAIN.group_override, {
    summary: (value) => (value === true ? "Prioritized" : "Not prioritized")
  }),
  number("group", "group_weight", "Group weight", EXPLAIN.group_weight, { min: 0 }),
  inherited("group", "use_group_scoring", "Group scoring", EXPLAIN.use_group_scoring, "off"),
  flag("recursion", "exclude_recursion", "Non-recursable", EXPLAIN.exclude_recursion),
  flag("recursion", "prevent_recursion", "Prevent further recursion", EXPLAIN.prevent_recursion),
  {
    section: "recursion",
    id: "delay_until_recursion",
    label: "Delay until recursion",
    description: EXPLAIN.delay_until_recursion,
    input: { kind: "switch" },
    current: (entry) => entry.delay_until_recursion !== false && entry.delay_until_recursion !== 0,
    patch: (value: MassValue) => ({ delay_until_recursion: value === true }),
    single: ({ store, path }) => <DelayUntilRecursion store={store} path={[...path, "delay_until_recursion"]} />
  },
  flag("recursion", "ignore_budget", "Ignore the token budget", EXPLAIN.ignore_budget),
  flag("recursion", "use_probability", "Use the trigger %", EXPLAIN.use_probability),
  number("timing", "sticky", "Sticky", EXPLAIN.sticky, { min: 0, integer: true, nullable: true }),
  number("timing", "cooldown", "Cooldown", EXPLAIN.cooldown, { min: 0, integer: true, nullable: true }),
  number("timing", "delay", "Delay", EXPLAIN.delay, { min: 0, integer: true, nullable: true }),
  {
    section: "timing",
    id: "character_filter",
    label: "Character filter",
    description: "Which characters the entry is included for.",
    input: { kind: "text" },
    current: (entry) =>
      entry.character_filter
        ? `${entry.character_filter.is_exclude ? "Not " : ""}${[...entry.character_filter.names, ...entry.character_filter.tags].join(", ")}`
        : "",
    patch: () => ({}),
    many: false,
    single: ({ store, path }) => <CharacterFilter store={store} path={[...path, "character_filter"]} />,
    summary: (value) => `Characters: ${String(value)}`
  },
  {
    section: "export",
    id: "automation_id",
    field: "automation_id",
    label: "Automation ID",
    description: "The automation an exported entry runs when it's included.",
    input: { kind: "text" },
    current: (entry) => entry.automation_id,
    patch: (value: MassValue) => ({ automation_id: String(value ?? "") })
  },
  flag("export", "add_memo", "Add the title as a memo", "An exported entry adds its title as a memo."),
  {
    section: "export",
    id: "name",
    label: "Name in exports",
    description: "The entry's name in an exported card.",
    input: { kind: "text" },
    current: (entry) => entry.name ?? "",
    patch: () => ({}),
    many: false,
    card: true,
    single: ({ store, path }) => (
      <TextField
        store={store}
        path={[...path, "name"]}
        label="Name in exports"
        about="The entry's name in an exported card."
      />
    )
  },
  {
    section: "export",
    id: "priority",
    label: "Priority in exports",
    description: "The entry's priority in an exported card. Order decides here.",
    input: { kind: "number" },
    current: (entry) => entry.priority ?? null,
    patch: () => ({}),
    many: false,
    card: true,
    single: ({ store, path }) => (
      <NumberField
        store={store}
        path={[...path, "priority"]}
        label="Priority in exports"
        about="The entry's priority in an exported card. Order decides here."
        optional
      />
    )
  },
  flag(
    "export",
    "use_regex",
    "Keys are regular expressions",
    "An exported card marks its keys as regular expressions. Keys here are regular expressions when written as /pattern/flags.",
    { card: true }
  )
]

export const registerLorebookEntrySettings = () => {
  SECTIONS.forEach((section, index) => lorebookEntrySections.register({ ...section, order: (index + 1) * 10 }))
  SETTINGS.forEach((setting, index) => lorebookEntrySettings.register({ ...setting, order: (index + 1) * 10 }))
}
