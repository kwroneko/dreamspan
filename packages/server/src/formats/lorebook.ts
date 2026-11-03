// Lorebooks: a card's `character_book` (V2/V3) and our lorebook document. The field
// mapping follows ST's `convertCharacterBook` (public/scripts/world-info.js), which keeps
// its World Info fields in each entry's `extensions`.
import {
  CharacterFilter,
  LOREBOOK_SCHEMA_VERSION,
  type LorebookDoc,
  type LorebookEntry,
  type LorePosition,
  type LoreRole,
  PlacementOverride,
  type SelectiveLogic
} from "@rp/shared/docs/lorebook.ts"
import type { ReportBuilder } from "@rp/shared/importReport.ts"
import { Predicate, Schema } from "effect"
import { enumByIndex, Fields, hasKeys, isFiniteNumber, isSafeInt, present } from "./fields.ts"
import { fail, type Limits, type Path } from "./safety.ts"

/** Our namespace in `extensions`, for what a standard card or lorebook has no field for. */
export const OUR_EXTENSION = "rp_harness"

/** A position in ST's files: ours, or before or after ST's author's note, which an import places. */
type StPosition = LorePosition | "an_top" | "an_bottom"

/** ST's `world_info_position` by its index in ST's files; 2 and 3 are before and after its author's note. */
export const POSITIONS: ReadonlyArray<StPosition> = [
  "before_char",
  "after_char",
  "an_top",
  "an_bottom",
  "at_depth",
  "em_top",
  "em_bottom",
  "outlet"
]
export const LOGICS: ReadonlyArray<SelectiveLogic> = ["and_any", "not_all", "not_any", "and_all"]
export const ROLES: ReadonlyArray<LoreRole> = ["system", "user", "assistant"]

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
export const ourEntryFields = (extensions: Record<string, unknown>, path: Path, issues: ReportBuilder) => {
  const ours = extensions[OUR_EXTENSION]
  if (!Predicate.isObject(ours)) return {}
  const fields = new Fields(ours, [...path, "extensions", OUR_EXTENSION], issues)
  return {
    ...fields.optional("character_filter", Schema.is(CharacterFilter), "a character filter"),
    ...fields.optional("decision_hint", Predicate.isString, "text"),
    ...fields.optional("placement_override", isPlacement, "a placement")
  }
}

/**
 * `extensions` without the keys we lifted out of it. It's the parsed object itself with those
 * keys deleted, so a huge one isn't copied: call it after every read of `extensions`.
 */
export const remainingExtensions = (extensions: Record<string, unknown>, lifted: ReadonlySet<string>) => {
  for (const key of lifted) delete extensions[key]
  const ours = extensions[OUR_EXTENSION]
  if (Predicate.isObject(ours)) {
    delete ours.character_filter
    delete ours.decision_hint
    delete ours.placement_override
    if (!hasKeys(ours)) delete extensions[OUR_EXTENSION]
  }
  return extensions
}

/** An entry before its uid is settled. `id` is the one its file gave it, when usable. */
export interface Candidate {
  readonly id: number | undefined
  readonly entry: Omit<LorebookEntry, "uid">
}

/** A candidate as read from ST's file, its position possibly at ST's author's note. */
export interface StCandidate {
  readonly id: number | undefined
  readonly entry: Omit<LorebookEntry, "uid" | "position"> & { readonly position: StPosition }
}

/**
 * Settles uids, which the merge matches entries by: unique safe integers. Usable ids are kept,
 * the first one wins, and every other entry gets a number no entry has, after the largest.
 */
export const assignUids = (candidates: ReadonlyArray<Candidate>, path: Path, issues: ReportBuilder) => {
  const taken = new Set<number>()
  const kept = candidates.map((candidate) => {
    if (candidate.id === undefined || taken.has(candidate.id)) return false
    taken.add(candidate.id)
    return true
  })
  let next = 0
  for (const id of taken) next = Math.max(next, id + 1)
  if (!Number.isSafeInteger(next)) next = 0
  return candidates.map((candidate, index): LorebookEntry => {
    if (kept[index]) return { uid: candidate.id!, ...candidate.entry }
    while (taken.has(next)) next++
    taken.add(next)
    if (candidate.id !== undefined) {
      issues.add("warning", "lorebook.duplicate_id", `Entry ${index} had a duplicate id; it was given ${next}.`, [
        ...path,
        "entries",
        index
      ])
    }
    return { uid: next, ...candidate.entry }
  })
}

/** Caps a lorebook's entries: each becomes an object of some fifty fields. */
export const checkEntryCount = (count: number, limits: Limits) => {
  if (count > limits.maxLorebookEntries) {
    fail("lorebook.too_many_entries", `The lorebook has more than ${limits.maxLorebookEntries} entries.`)
  }
}

const cardEntry = (source: unknown, index: number, path: Path, issues: ReportBuilder): StCandidate | undefined => {
  const entryPath = [...path, "entries", index]
  if (!Predicate.isObject(source)) {
    issues.add("warning", "lorebook.invalid_entry", `Entry ${index} isn't an object; it was dropped.`, entryPath)
    return undefined
  }
  const entry = new Fields(source, entryPath, issues)
  const extensions = entry.object("extensions")
  const ext = new Fields(extensions, [...entryPath, "extensions"], issues)
  if (!entry.has("enabled")) {
    issues.add(
      "warning",
      "lorebook.disabled",
      `Entry ${index} doesn't say it's enabled, so it's disabled, as in ST.`,
      entryPath
    )
  }
  // An id the merge can't use is replaced, and kept to be written back on export.
  const invalidId = entry.has("id") && !isSafeInt(source.id)
  if (invalidId) {
    issues.add(
      "warning",
      "lorebook.invalid_id",
      `Entry ${index} had an id that isn't a whole number; it was replaced.`,
      [...entryPath, "id"]
    )
  }
  const comment = entry.string("comment")
  return {
    id: isSafeInt(source.id) ? source.id : undefined,
    entry: {
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
      ...entry.optional("name", Predicate.isString, "text"),
      ...entry.optional("priority", isFiniteNumber, "a number"),
      use_regex: entry.boolean("use_regex", false),
      ...ourEntryFields(extensions, entryPath, issues),
      extensions: remainingExtensions(extensions, ST_EXTENSION_KEYS),
      ...entry.unknown(ENTRY_KEYS, invalidId ? { id: source.id } : {})
    }
  }
}

export const isRecursionDelay = (value: unknown): value is boolean | number =>
  Predicate.isBoolean(value) || isSafeInt(value)

/** Where an entry ST placed before or after its author's note goes: a depth and a role. */
export interface AuthorNoteLore {
  readonly depth: number
  readonly role: LoreRole
}

/** ST's default author's note place: in the chat at depth 4, as the system. */
export const DEFAULT_AUTHOR_NOTE_LORE: AuthorNoteLore = { depth: 4, role: "system" }

/**
 * Entries ST placed before or after its author's note (positions 2 and 3), at a concrete place
 * instead, kept (owner, 2026-11-01): `place`, the author's note's depth and role. A file's
 * book has no chat, so an upload takes ST's default author's note place (depth 4, the system)
 * and a folder import the folder's default author's note's. The report says so once.
 */
export const placeAuthorNoteEntries = (
  candidates: ReadonlyArray<StCandidate>,
  place: AuthorNoteLore,
  path: Path,
  issues: ReportBuilder
): Array<Candidate> => {
  let moved = 0
  let riders = 0
  const placed = candidates.map(({ id, entry }): Candidate => {
    const { position } = entry
    if (position !== "an_top" && position !== "an_bottom") return { id, entry: { ...entry, position } }
    moved++
    if (entry.enabled && entry.content !== "") riders++
    return { id, entry: { ...entry, position: "at_depth", depth: place.depth, role: place.role } }
  })
  if (moved > 0)
    issues.add(
      "info",
      "lorebook.author_note_entries",
      `${moved === 1 ? "An entry" : `${moved} entries`} ST placed before or after the author's note ${moved === 1 ? "is" : "are"} at depth ${place.depth} as ${place.role} here, where ST's default author's note is.`,
      path
    )
  // The folder import distinguishes text that could ride on a chat's note from disabled or
  // empty entries. Keep the all-entries signal above for placement-sensitive reimport hashes.
  if (riders > 0)
    issues.add(
      "info",
      "lorebook.author_note_riders",
      `${riders} enabled, non-empty entries can contribute text at the author's note.`,
      path
    )
  return placed
}

/** A card's `character_book` as our lorebook document. */
export const lorebookFromCharacterBook = (
  source: Record<string, unknown>,
  path: Path,
  limits: Limits,
  issues: ReportBuilder
): LorebookDoc => {
  const book = new Fields(source, path, issues)
  const entries = book.list("entries")
  checkEntryCount(entries.length, limits)
  return {
    schema_version: LOREBOOK_SCHEMA_VERSION,
    name: book.string("name"),
    description: book.string("description"),
    scan_depth: book.nullableInt("scan_depth"),
    token_budget: book.nullableInt("token_budget"),
    recursive_scanning: book.nullableBoolean("recursive_scanning"),
    extensions: book.object("extensions"),
    entries: assignUids(
      placeAuthorNoteEntries(
        entries.flatMap((entry, index) => cardEntry(entry, index, path, issues) ?? []),
        DEFAULT_AUTHOR_NOTE_LORE,
        path,
        issues
      ),
      path,
      issues
    ),
    ...book.unknown(BOOK_KEYS)
  }
}

/** `extensions` with our own entry fields put back in our namespace. */
export const withOurFields = (entry: LorebookEntry) => {
  const ours = present({
    decision_hint: entry.decision_hint,
    placement_override: entry.placement_override,
    character_filter: entry.character_filter
  })
  if (Object.keys(ours).length === 0) return entry.extensions
  const existing = entry.extensions[OUR_EXTENSION]
  return { ...entry.extensions, [OUR_EXTENSION]: { ...(Predicate.isObject(existing) ? existing : {}), ...ours } }
}

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
    // An id the import had to replace goes back as it was.
    id: entry.unknown_fields?.id ?? entry.uid,
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
