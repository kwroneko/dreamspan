// The settings "Change for selected…" offers by default (lorebookMass.ts): one at a time, so
// only that setting changes on the selected entries.
import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import { EXPLAIN } from "./lorebookExplain.ts"
import { type LorebookMassSetting, lorebookMassSettings, type MassValue } from "./lorebookMass.ts"
import { POSITIONS, positionValue, strategyOf } from "./lorebookTable.ts"

type Setting = Omit<LorebookMassSetting, "order">

const onOff = { kind: "switch", on: "On", off: "Off" } as const

const flag = (id: keyof LorebookEntry & string, label: string, description: string): Setting => ({
  id,
  label,
  description,
  input: onOff,
  current: (entry) => Boolean(entry[id]),
  patch: (value) => ({ [id]: value === true })
})

const number = (
  id: "depth" | "order" | "group_weight" | "scan_depth" | "sticky" | "cooldown" | "delay",
  label: string,
  description: string,
  options: { min?: number; max?: number; integer?: boolean; nullable?: boolean } = {}
): Setting => ({
  id,
  label,
  description,
  input: { kind: "number", ...options },
  current: (entry) => entry[id],
  patch: (value) => ({ [id]: value === null || value === "" ? null : Number(value) })
})

/** A setting that's unset (null: ST's default), on or off. */
const inherited = (
  id: "case_sensitive" | "match_whole_words" | "use_group_scoring",
  label: string,
  description: string,
  fallback: "on" | "off"
): Setting => ({
  id,
  label,
  description,
  input: {
    kind: "choice",
    options: [
      {
        value: "inherit",
        label: `Default (${fallback})`,
        description: "Not set on the entry, so the default applies."
      },
      { value: "true", label: "On" },
      { value: "false", label: "Off" }
    ]
  },
  current: (entry) => (entry[id] === null ? "inherit" : String(entry[id])),
  patch: (value) => ({ [id]: value === "inherit" ? null : value === "true" })
})

const MATCH_SOURCES = [
  ["match_persona_description", "Persona description"],
  ["match_character_description", "Character description"],
  ["match_character_personality", "Personality"],
  ["match_character_depth_prompt", "Character's note"],
  ["match_scenario", "Scenario"],
  ["match_creator_notes", "Creator's notes"]
] as const

const SETTINGS: ReadonlyArray<Setting> = [
  flag("enabled", "Enabled", EXPLAIN.enabled),
  {
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
    patch: (value: MassValue) => ({ constant: value === "constant", vectorized: value === "vectorized" })
  },
  {
    id: "position",
    label: "Position",
    description: EXPLAIN.position,
    input: {
      kind: "choice",
      options: POSITIONS.map((item) => ({ value: item.value, label: item.label, description: item.description }))
    },
    current: positionValue,
    patch: (value: MassValue) => {
      const picked = POSITIONS.find((item) => item.value === value)!
      return picked.role ? { position: picked.position, role: picked.role } : { position: picked.position }
    }
  },
  number("depth", "Depth", EXPLAIN.depth, { min: 0, integer: true }),
  number("order", "Order", EXPLAIN.order),
  {
    id: "probability",
    label: "Trigger %",
    description: `${EXPLAIN.probability} Setting it also turns “Use the trigger %” on.`,
    input: { kind: "number", min: 0, max: 100, integer: true },
    current: (entry) => entry.probability,
    patch: (value: MassValue) => ({ probability: Number(value), use_probability: true })
  },
  flag("use_probability", "Use the trigger %", EXPLAIN.use_probability),
  flag("selective", "Use secondary keys", EXPLAIN.selective),
  {
    id: "selective_logic",
    label: "Secondary key logic",
    description: EXPLAIN.selective_logic,
    input: {
      kind: "choice",
      options: [
        { value: "and_any", label: "AND ANY", description: "At least one secondary key also appears." },
        { value: "and_all", label: "AND ALL", description: "Every secondary key also appears." },
        { value: "not_any", label: "NOT ANY", description: "None of the secondary keys appears." },
        { value: "not_all", label: "NOT ALL", description: "At least one secondary key is missing." }
      ]
    },
    current: (entry) => entry.selective_logic,
    patch: (value: MassValue) => ({ selective_logic: value as LorebookEntry["selective_logic"] })
  },
  inherited("case_sensitive", "Case sensitive", EXPLAIN.case_sensitive, "off"),
  inherited("match_whole_words", "Whole words", EXPLAIN.match_whole_words, "on"),
  number("scan_depth", "Scan depth", EXPLAIN.scan_depth, { min: 0, integer: true, nullable: true }),
  ...MATCH_SOURCES.map(([id, label]) => flag(id, `Also look for keys in: ${label}`, EXPLAIN.match_sources)),
  {
    id: "group",
    label: "Inclusion group",
    description: EXPLAIN.group,
    input: { kind: "text" },
    current: (entry) => entry.group,
    patch: (value: MassValue) => ({ group: String(value ?? "") })
  },
  flag("group_override", "Prioritize in its group", EXPLAIN.group_override),
  number("group_weight", "Group weight", EXPLAIN.group_weight, { min: 0 }),
  inherited("use_group_scoring", "Group scoring", EXPLAIN.use_group_scoring, "off"),
  flag("exclude_recursion", "Non-recursable", EXPLAIN.exclude_recursion),
  flag("prevent_recursion", "Prevent further recursion", EXPLAIN.prevent_recursion),
  {
    id: "delay_until_recursion",
    label: "Delay until recursion",
    description: EXPLAIN.delay_until_recursion,
    input: onOff,
    current: (entry) => entry.delay_until_recursion !== false && entry.delay_until_recursion !== 0,
    patch: (value: MassValue) => ({ delay_until_recursion: value === true })
  },
  flag("ignore_budget", "Ignore the token budget", EXPLAIN.ignore_budget),
  number("sticky", "Sticky", EXPLAIN.sticky, { min: 0, integer: true, nullable: true }),
  number("cooldown", "Cooldown", EXPLAIN.cooldown, { min: 0, integer: true, nullable: true }),
  number("delay", "Delay", EXPLAIN.delay, { min: 0, integer: true, nullable: true })
]

export const registerLorebookMassSettings = () =>
  SETTINGS.forEach((setting, index) => lorebookMassSettings.register({ ...setting, order: (index + 1) * 10 }))
