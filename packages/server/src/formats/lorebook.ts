// Lorebooks: a card's `character_book` (V2/V3) and our lorebook document. The field
// mapping follows ST's `convertCharacterBook` (public/scripts/world-info.js), which keeps
// its World Info fields in each entry's `extensions`.
import {
  LOREBOOK_SCHEMA_VERSION,
  type LorebookDoc,
  type LorebookEntry,
  type LorePosition,
  type LoreRole,
  PlacementOverride,
  type SelectiveLogic
} from "@rp/shared/docs/lorebook.ts"
import { Schema } from "effect"
import { enumByIndex, Fields, isBoolean, isFinite, isString } from "./fields.ts"
import { type Issues, isObject, type Path } from "./safety.ts"

/** Our namespace in `extensions`, for what a standard card or lorebook has no field for. */
export const OUR_EXTENSION = "rp_harness"

const POSITIONS: ReadonlyArray<LorePosition> = [
  "before_char",
  "after_char",
  "an_top",
  "an_bottom",
  "at_depth",
  "em_top",
  "em_bottom",
  "outlet"
]
const LOGICS: ReadonlyArray<SelectiveLogic> = ["and_any", "not_all", "not_any", "and_all"]
const ROLES: ReadonlyArray<LoreRole> = ["system", "user", "assistant"]

const BOOK_KEYS = new Set([
  "name",
  "description",
  "scan_depth",
  "token_budget",
  "recursive_scanning",
  "extensions",
  "entries"
])
const ENTRY_KEYS = new Set([
  "id",
  "keys",
  "secondary_keys",
  "comment",
  "content",
  "constant",
  "selective",
  "insertion_order",
  "enabled",
  "position",
  "case_sensitive",
  "name",
  "priority",
  "use_regex",
  "extensions"
])
/** ST's World Info fields inside a card entry's `extensions`, lifted into our entry. */
const ST_EXTENSION_KEYS = new Set([
  "position",
  "exclude_recursion",
  "display_index",
  "probability",
  "useProbability",
  "depth",
  "selectiveLogic",
  "outlet_name",
  "group",
  "group_override",
  "group_weight",
  "prevent_recursion",
  "delay_until_recursion",
  "scan_depth",
  "match_whole_words",
  "use_group_scoring",
  "case_sensitive",
  "automation_id",
  "role",
  "vectorized",
  "sticky",
  "cooldown",
  "delay",
  "match_persona_description",
  "match_character_description",
  "match_character_personality",
  "match_character_depth_prompt",
  "match_scenario",
  "match_creator_notes",
  "triggers",
  "ignore_budget"
])

const isPlacement = Schema.is(PlacementOverride)

/** Our own entry fields, kept in `extensions.rp_harness` by the standard formats. */
const ourEntryFields = (extensions: Record<string, unknown>, path: Path, issues: Issues) => {
  const ours = extensions[OUR_EXTENSION]
  if (!isObject(ours)) return {}
  const fields = new Fields(ours, [...path, "extensions", OUR_EXTENSION], issues)
  return {
    ...fields.optional("decision_hint", isString, "text"),
    ...fields.optional("placement_override", isPlacement, "a placement")
  }
}

/** `extensions` without the keys we lifted out of it. */
const remainingExtensions = (extensions: Record<string, unknown>, lifted: ReadonlySet<string>) => {
  const rest = Object.entries(extensions).filter(([key]) => !lifted.has(key))
  const ours = extensions[OUR_EXTENSION]
  if (isObject(ours)) {
    const ourRest = Object.entries(ours).filter(([key]) => key !== "decision_hint" && key !== "placement_override")
    const index = rest.findIndex(([key]) => key === OUR_EXTENSION)
    if (ourRest.length > 0) rest[index] = [OUR_EXTENSION, Object.fromEntries(ourRest)]
    else rest.splice(index, 1)
  }
  return Object.fromEntries(rest)
}

/** Makes uids unique integers: the merge matches entries by them. */
const uniqueUids = (entries: Array<LorebookEntry>, path: Path, issues: Issues) => {
  const seen = new Set<number>()
  let next = Math.max(-1, ...entries.map((entry) => entry.uid)) + 1
  return entries.map((entry, index) => {
    if (!seen.has(entry.uid)) {
      seen.add(entry.uid)
      return entry
    }
    issues.warn("lorebook.duplicate_id", `Entry ${index} had a duplicate id; it was given ${next}.`, [
      ...path,
      "entries",
      index
    ])
    seen.add(next)
    return { ...entry, uid: next++ }
  })
}

const cardEntry = (source: unknown, index: number, path: Path, issues: Issues): LorebookEntry | undefined => {
  const entryPath = [...path, "entries", index]
  if (!isObject(source)) {
    issues.warn("lorebook.invalid_entry", `Entry ${index} isn't an object; it was dropped.`, entryPath)
    return undefined
  }
  const entry = new Fields(source, entryPath, issues)
  const extensions = entry.object("extensions")
  const ext = new Fields(extensions, [...entryPath, "extensions"], issues)
  if (!entry.has("enabled")) {
    issues.warn("lorebook.disabled", `Entry ${index} doesn't say it's enabled, so it's disabled, as in ST.`, entryPath)
  }
  if (entry.has("id") && !Number.isInteger(source.id)) {
    issues.warn("lorebook.duplicate_id", `Entry ${index} had an id that isn't a whole number; it was replaced.`, [
      ...entryPath,
      "id"
    ])
  }
  const comment = entry.string("comment")
  return {
    uid: Number.isInteger(source.id) ? (source.id as number) : index,
    keys: entry.strings("keys", "commas"),
    secondary_keys: entry.strings("secondary_keys", "commas"),
    comment,
    content: entry.string("content"),
    constant: entry.boolean("constant", false),
    selective: entry.boolean("selective", false),
    selective_logic: enumByIndex(ext, "selectiveLogic", LOGICS, "and_any"),
    enabled: entry.boolean("enabled", false),
    order: entry.number("insertion_order", 100),
    position: ext.has("position")
      ? enumByIndex(ext, "position", POSITIONS, "before_char")
      : source.position === "before_char"
        ? "before_char"
        : "after_char",
    depth: ext.int("depth", 4),
    role: enumByIndex(ext, "role", ROLES, "system"),
    outlet_name: ext.string("outlet_name"),
    probability: ext.number("probability", 100),
    use_probability: ext.boolean("useProbability", true),
    group: ext.string("group"),
    group_override: ext.boolean("group_override", false),
    group_weight: ext.number("group_weight", 100),
    use_group_scoring: ext.nullableBoolean("use_group_scoring"),
    scan_depth: ext.nullableInt("scan_depth"),
    // ST reads only the extension; the spec's own field is the fallback.
    case_sensitive: ext.has("case_sensitive")
      ? ext.nullableBoolean("case_sensitive")
      : entry.nullableBoolean("case_sensitive"),
    match_whole_words: ext.nullableBoolean("match_whole_words"),
    sticky: ext.nullableInt("sticky"),
    cooldown: ext.nullableInt("cooldown"),
    delay: ext.nullableInt("delay"),
    exclude_recursion: ext.boolean("exclude_recursion", false),
    prevent_recursion: ext.boolean("prevent_recursion", false),
    delay_until_recursion: ext.value("delay_until_recursion", false, isRecursionDelay, "true, false or a level"),
    ignore_budget: ext.boolean("ignore_budget", false),
    vectorized: ext.boolean("vectorized", false),
    automation_id: ext.string("automation_id"),
    triggers: ext.strings("triggers"),
    match_persona_description: ext.boolean("match_persona_description", false),
    match_character_description: ext.boolean("match_character_description", false),
    match_character_personality: ext.boolean("match_character_personality", false),
    match_character_depth_prompt: ext.boolean("match_character_depth_prompt", false),
    match_scenario: ext.boolean("match_scenario", false),
    match_creator_notes: ext.boolean("match_creator_notes", false),
    add_memo: comment !== "",
    display_index: ext.int("display_index", index),
    ...entry.optional("name", isString, "text"),
    ...entry.optional("priority", isFinite, "a number"),
    use_regex: entry.boolean("use_regex", false),
    ...ourEntryFields(extensions, entryPath, issues),
    extensions: remainingExtensions(extensions, ST_EXTENSION_KEYS),
    ...entry.unknown(ENTRY_KEYS)
  }
}

const isRecursionDelay = (value: unknown): value is boolean | number => isBoolean(value) || Number.isInteger(value)

/** A card's `character_book` as our lorebook document. */
export const lorebookFromCharacterBook = (source: Record<string, unknown>, path: Path, issues: Issues): LorebookDoc => {
  const book = new Fields(source, path, issues)
  return {
    schema_version: LOREBOOK_SCHEMA_VERSION,
    name: book.string("name"),
    description: book.string("description"),
    scan_depth: book.nullableInt("scan_depth"),
    token_budget: book.nullableInt("token_budget"),
    recursive_scanning: book.nullableBoolean("recursive_scanning"),
    extensions: book.object("extensions"),
    entries: uniqueUids(
      book.list("entries").flatMap((entry, index) => cardEntry(entry, index, path, issues) ?? []),
      path,
      issues
    ),
    ...book.unknown(BOOK_KEYS)
  }
}

/** `extensions` with our own entry fields put back in our namespace. */
const withOurFields = (entry: LorebookEntry) => {
  const ours = present({ decision_hint: entry.decision_hint, placement_override: entry.placement_override })
  if (Object.keys(ours).length === 0) return entry.extensions
  const existing = entry.extensions[OUR_EXTENSION]
  return { ...entry.extensions, [OUR_EXTENSION]: { ...(isObject(existing) ? existing : {}), ...ours } }
}

/** The fields that have a value: optional fields stay absent when they have none. */
export const present = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null))

/**
 * Our lorebook as a card's `character_book`, as ST's `convertWorldInfoToCharacterBook`
 * (src/endpoints/characters.js) writes it. One difference: `use_regex` is false unless the
 * entry says otherwise. ST writes true, but its keys are plain text, which a V3 reader
 * would take as patterns.
 */
export const characterBookFromLorebook = (book: LorebookDoc) => ({
  ...book.unknown_fields,
  ...present({
    name: book.name || undefined,
    description: book.description || undefined,
    scan_depth: book.scan_depth,
    token_budget: book.token_budget,
    recursive_scanning: book.recursive_scanning
  }),
  extensions: book.extensions,
  entries: book.entries.map((entry) => ({
    ...entry.unknown_fields,
    id: entry.uid,
    keys: entry.keys,
    secondary_keys: entry.secondary_keys,
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    insertion_order: entry.order,
    enabled: entry.enabled,
    position: entry.position === "before_char" ? "before_char" : "after_char",
    use_regex: entry.use_regex,
    ...present({ name: entry.name, priority: entry.priority, case_sensitive: entry.case_sensitive }),
    extensions: {
      ...withOurFields(entry),
      position: POSITIONS.indexOf(entry.position),
      exclude_recursion: entry.exclude_recursion,
      ...present({ display_index: entry.display_index }),
      probability: entry.probability,
      useProbability: entry.use_probability,
      depth: entry.depth,
      selectiveLogic: LOGICS.indexOf(entry.selective_logic),
      outlet_name: entry.outlet_name,
      group: entry.group,
      group_override: entry.group_override,
      group_weight: entry.group_weight,
      prevent_recursion: entry.prevent_recursion,
      delay_until_recursion: entry.delay_until_recursion,
      scan_depth: entry.scan_depth,
      match_whole_words: entry.match_whole_words,
      use_group_scoring: entry.use_group_scoring,
      case_sensitive: entry.case_sensitive,
      automation_id: entry.automation_id,
      role: ROLES.indexOf(entry.role),
      vectorized: entry.vectorized,
      sticky: entry.sticky,
      cooldown: entry.cooldown,
      delay: entry.delay,
      match_persona_description: entry.match_persona_description,
      match_character_description: entry.match_character_description,
      match_character_personality: entry.match_character_personality,
      match_character_depth_prompt: entry.match_character_depth_prompt,
      match_scenario: entry.match_scenario,
      match_creator_notes: entry.match_creator_notes,
      triggers: entry.triggers,
      ignore_budget: entry.ignore_budget
    }
  }))
})
