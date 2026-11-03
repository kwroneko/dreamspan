// A lorebook entry's settings form (owner, 2026-11-02): its sections and the settings in each,
// as registries a plugin can add to, replace or disable (spec/PLUGINS.md §8). One form serves
// one entry (LorebookEntryDetails: accordions in the side panel, two open columns in the large
// editor) and many at once ("Edit N entries", LorebookMassEdit), where each setting has a
// checkbox to change it on every selected entry. The defaults are in lorebookSettingsDefaults.tsx.
import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"
import type { FieldPath } from "@rp/shared/editing.ts"
import type { ComponentType, ReactNode } from "react"
import { makeRegistry } from "../../registry.ts"
import { emptyEntry } from "./lorebookDefaults.ts"
import type { EditorStore } from "./store.ts"

export type MassValue = string | number | boolean | null

/** How a setting's value is picked when no `single` renderer is given, and in the many-entries form. */
export type SettingInput =
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
  | { readonly kind: "switch" }
  | { readonly kind: "text" }
  /** Unset (the default applies), on or off: "inherit", "true" or "false". */
  | { readonly kind: "inherit"; readonly fallback: "on" | "off" }

/** One entry's setting, as a field of its own (`single`) renders it. */
export interface SingleSettingProps {
  readonly store: EditorStore
  /** The entry's path. */
  readonly path: FieldPath
  readonly setting: LorebookEntrySetting
}

export interface LorebookEntrySetting {
  readonly id: string
  readonly order: number
  /** The section it's in (lorebookEntrySections). */
  readonly section: string
  readonly label: string
  /** What it does: its "?" explanation. */
  readonly description: string
  readonly input: SettingInput
  /** Its value on an entry: what the summary says, what's compared with the defaults and across entries. */
  readonly current: (entry: LorebookEntry) => MassValue
  /** The fields it sets for a value: only these change. `null` clears it (its default). */
  readonly patch: (value: MassValue) => Partial<LorebookEntry>
  /** The entry field it edits, when it's one field: the single-entry form binds the control to it. */
  readonly field?: keyof LorebookEntry & string
  /** How one entry's form shows it, instead of the control for its `input`. */
  readonly single?: ComponentType<SingleSettingProps>
  /** Shown in one entry's form only when this holds (the logic, once secondary keys are on). */
  readonly visible?: (entry: LorebookEntry) => boolean
  /** Not offered when editing several entries (a list of keys, the character filter). */
  readonly many?: false
  /** Only in a card's own book. */
  readonly card?: true
  /** Grouped under this heading with its neighbours of the same group ("Also look for keys in"). */
  readonly group?: string
  /** Its value in a summary, "Off" when it's a switch that's off; the value's label by default. */
  readonly summary?: (value: MassValue) => string
}
export const lorebookEntrySettings = makeRegistry<LorebookEntrySetting>()

/** What a section's body gets when it renders itself for one entry (the row's columns, say). */
export interface SingleSectionProps {
  readonly store: EditorStore
  readonly path: FieldPath
  readonly entry: LorebookEntry
  /** The row's own settings where the row doesn't show them (LorebookTable's Essentials). */
  readonly essentials?: ReactNode
}

export interface LorebookEntrySection {
  readonly id: string
  readonly order: number
  readonly title: string
  /** The accordion header's explanation. */
  readonly hint: string
  /** The column it's in on a wide screen. */
  readonly column: 0 | 1
  /** Only in a card's own book. */
  readonly card?: true
  /** Shown for one entry only when this holds; `compact`: the row hides its columns. */
  readonly visible?: (entry: LorebookEntry, compact: boolean) => boolean
  /** One entry's form shows this before its settings' fields (the row's columns, in Essentials). */
  readonly lead?: ComponentType<SingleSectionProps>
}
export const lorebookEntrySections = makeRegistry<LorebookEntrySection>()

const DEFAULT = emptyEntry(0)

/** The setting's default value, as a new entry has it. */
export const defaultOf = (setting: LorebookEntrySetting) => setting.current(DEFAULT)

/** Whether the entry's value differs from a new entry's. */
export const changed = (setting: LorebookEntrySetting, entry: LorebookEntry) =>
  JSON.stringify(setting.current(entry)) !== JSON.stringify(defaultOf(setting))

/** A value in words: "On", "AND ANY", "12", "empty". */
export const valueText = (setting: LorebookEntrySetting, value: MassValue): string => {
  const input = setting.input
  if (input.kind === "choice") return input.options.find((option) => option.value === value)?.label ?? String(value)
  if (input.kind === "inherit")
    return value === "inherit" ? `Default (${input.fallback})` : value === "true" ? "On" : "Off"
  if (input.kind === "switch") return value === true ? "On" : "Off"
  if (value === null || value === "") return "empty"
  return String(value)
}

/** One setting's part of its section's summary: "Sticky 3", "Non-recursable", "Whole words off". */
const summaryPart = (setting: LorebookEntrySetting, value: MassValue) => {
  if (setting.summary) return setting.summary(value)
  if (setting.input.kind === "switch") return value === true ? setting.label : `${setting.label} off`
  return `${setting.label} ${valueText(setting, value)}`
}

/** A section's one-line summary: what differs from the defaults, or that nothing does. */
export const sectionSummary = (settings: ReadonlyArray<LorebookEntrySetting>, entry: LorebookEntry) => {
  const parts = settings.filter((setting) => changed(setting, entry)).map((s) => summaryPart(s, s.current(entry)))
  return parts.length > 0 ? parts.join(" · ") : "Default settings"
}

/**
 * The settings of the sections in order, grouped: what a form lays out. `card` keeps a card
 * book's own settings; `many` keeps those offered for several entries.
 */
export const formSections = (
  sections: ReadonlyArray<LorebookEntrySection>,
  settings: ReadonlyArray<LorebookEntrySetting>,
  { card, many }: { card: boolean; many: boolean }
) =>
  sections
    .filter((section) => card || !section.card)
    .map((section) => ({
      section,
      settings: settings.filter(
        (setting) => setting.section === section.id && (card || !setting.card) && (!many || setting.many !== false)
      )
    }))

/** What several entries have for a setting: one value, or "Mixed" with how many have which. */
export type Common =
  { readonly mixed: false; readonly value: MassValue } | { readonly mixed: true; readonly breakdown: string }

export const commonValue = (setting: LorebookEntrySetting, entries: ReadonlyArray<LorebookEntry>): Common => {
  const counts = new Map<string, { value: MassValue; count: number }>()
  for (const entry of entries) {
    const value = setting.current(entry)
    const key = JSON.stringify(value)
    const seen = counts.get(key)
    if (seen) seen.count++
    else counts.set(key, { value, count: 1 })
  }
  const values = [...counts.values()]
  if (values.length <= 1) return { mixed: false, value: values[0]?.value ?? null }
  const word = (value: MassValue) => {
    const text = valueText(setting, value)
    return setting.input.kind === "switch" ? text.toLowerCase() : text
  }
  return {
    mixed: true,
    breakdown: values
      .sort((a, b) => b.count - a.count)
      .map(({ value, count }) => `${count.toLocaleString()} ${word(value)}`)
      .join(", ")
  }
}

/**
 * The fields the ticked settings set (`undefined`: nothing chosen yet, so it changes nothing;
 * an empty text or number clears the value), merged in the form's order.
 */
export const manyPatch = (
  settings: ReadonlyArray<LorebookEntrySetting>,
  ticked: Readonly<Record<string, MassValue | undefined>>
): Partial<LorebookEntry> =>
  Object.assign(
    {},
    ...settings.flatMap((setting) => {
      if (!(setting.id in ticked)) return []
      const value = ticked[setting.id]
      if (value === undefined) return []
      const empty = value === "" || value === null
      if (empty && setting.input.kind !== "text" && setting.input.kind !== "number") return []
      return [setting.patch(empty && setting.input.kind === "number" ? null : value)]
    })
  ) as Partial<LorebookEntry>
