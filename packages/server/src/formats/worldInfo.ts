// SillyTavern's standalone World Info files, to and from our lorebook document. Entry fields
// and their defaults are ST's `newWorldInfoEntryDefinition` (public/scripts/world-info.js);
// a file must have `entries`, as ST's import requires (src/endpoints/worldinfo.js).
import { formatByteSize } from "@rp/shared/byteSize.ts"
import { LOREBOOK_SCHEMA_VERSION, type LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { type ImportReport, ReportBuilder, shownText } from "@rp/shared/importReport.ts"
import { Context, type Effect, Predicate } from "effect"
import { enumByIndex, Fields, isSafeInt, present } from "./fields.ts"
import {
  assignUids,
  type AuthorNoteLore,
  DEFAULT_AUTHOR_NOTE_LORE,
  type StCandidate,
  checkEntryCount,
  isRecursionDelay,
  LOGICS,
  ourEntryFields,
  placeAuthorNoteEntries,
  POSITIONS,
  remainingExtensions,
  ROLES,
  withOurFields
} from "./lorebook.ts"
import { attempt, defaultLimits, fail, type FormatError, type Limits, parseJson, type Path } from "./safety.ts"

const BOOK_KEYS = new Set(["entries", "name", "extensions", "originalData"])

/**
 * Where a World Info entry ST placed before or after its author's note goes (`placeAuthorNoteEntries`):
 * ST's default author's note place unless the import knows the folder's (the ST folder import
 * provides it from `settings.json`).
 */
export const AuthorNoteLorePlace = Context.Reference<AuthorNoteLore>("rp/formats/AuthorNoteLorePlace", {
  defaultValue: () => DEFAULT_AUTHOR_NOTE_LORE
})
const ENTRY_KEYS = new Set([
  "uid",
  "key",
  "keysecondary",
  "comment",
  "content",
  "constant",
  "vectorized",
  "selective",
  "selectiveLogic",
  "addMemo",
  "order",
  "position",
  "disable",
  "ignoreBudget",
  "excludeRecursion",
  "preventRecursion",
  "matchPersonaDescription",
  "matchCharacterDescription",
  "matchCharacterPersonality",
  "matchCharacterDepthPrompt",
  "matchScenario",
  "matchCreatorNotes",
  "delayUntilRecursion",
  "probability",
  "useProbability",
  "depth",
  "outletName",
  "group",
  "groupOverride",
  "groupWeight",
  "scanDepth",
  "caseSensitive",
  "matchWholeWords",
  "useGroupScoring",
  "automationId",
  "role",
  "sticky",
  "cooldown",
  "delay",
  "characterFilter",
  "triggers",
  "displayIndex",
  "extensions"
])
const NOTHING = new Set<string>()

const characterFilter = (entry: Fields) => {
  if (!entry.has("characterFilter")) return {}
  const filter = new Fields(entry.object("characterFilter"), [...entry.path, "characterFilter"], entry.issues)
  return {
    character_filter: {
      is_exclude: filter.boolean("isExclude", false),
      names: filter.strings("names"),
      tags: filter.strings("tags")
    }
  }
}

const wiEntry = (
  key: string,
  keyed: boolean,
  source: unknown,
  index: number,
  issues: ReportBuilder
): StCandidate | undefined => {
  const path: Path = ["entries", key]
  if (!Predicate.isObject(source)) {
    issues.add("warning", "lorebook.invalid_entry", `Entry ${shownText(key)} isn't an object; it was dropped.`, path)
    return undefined
  }
  const entry = new Fields(source, path, issues)
  const extensions = entry.object("extensions")
  // ST keys its entries object by uid; in a list, the position is no id.
  const keyId = keyed && /^\d+$/.test(key) ? Number(key) : undefined
  return {
    id: isSafeInt(source.uid) ? source.uid : isSafeInt(keyId) ? keyId : undefined,
    entry: {
      keys: entry.strings("key", "commas"),
      secondary_keys: entry.strings("keysecondary", "commas"),
      comment: entry.string("comment"),
      content: entry.string("content"),
      constant: entry.boolean("constant", false),
      selective: entry.boolean("selective", true),
      selective_logic: enumByIndex(entry, "selectiveLogic", LOGICS, "and_any"),
      enabled: !entry.boolean("disable", false),
      order: entry.number("order", 100),
      position: enumByIndex(entry, "position", POSITIONS, "before_char"),
      depth: entry.int("depth", 4),
      role: enumByIndex(entry, "role", ROLES, "system"),
      outlet_name: entry.string("outletName"),
      probability: entry.number("probability", 100),
      use_probability: entry.boolean("useProbability", true),
      group: entry.string("group"),
      group_override: entry.boolean("groupOverride", false),
      group_weight: entry.number("groupWeight", 100),
      use_group_scoring: entry.nullableBoolean("useGroupScoring"),
      scan_depth: entry.nullableInt("scanDepth"),
      case_sensitive: entry.nullableBoolean("caseSensitive"),
      match_whole_words: entry.nullableBoolean("matchWholeWords"),
      sticky: entry.nullableInt("sticky"),
      cooldown: entry.nullableInt("cooldown"),
      delay: entry.nullableInt("delay"),
      exclude_recursion: entry.boolean("excludeRecursion", false),
      prevent_recursion: entry.boolean("preventRecursion", false),
      delay_until_recursion: entry.value("delayUntilRecursion", 0, isRecursionDelay, "true, false or a level"),
      ignore_budget: entry.boolean("ignoreBudget", false),
      vectorized: entry.boolean("vectorized", false),
      automation_id: entry.string("automationId"),
      triggers: entry.strings("triggers"),
      match_persona_description: entry.boolean("matchPersonaDescription", false),
      match_character_description: entry.boolean("matchCharacterDescription", false),
      match_character_personality: entry.boolean("matchCharacterPersonality", false),
      match_character_depth_prompt: entry.boolean("matchCharacterDepthPrompt", false),
      match_scenario: entry.boolean("matchScenario", false),
      match_creator_notes: entry.boolean("matchCreatorNotes", false),
      add_memo: entry.boolean("addMemo", false),
      ...(entry.has("displayIndex") ? { display_index: entry.int("displayIndex", index) } : {}),
      ...characterFilter(entry),
      use_regex: false,
      ...ourEntryFields(extensions, path, issues),
      // ST keeps them verbatim, its own copies of entry fields included.
      extensions: remainingExtensions(extensions, NOTHING),
      ...entry.unknown(ENTRY_KEYS)
    }
  }
}

/**
 * A World Info file as our lorebook. Its name is the file's own, or `fallbackName` (ST
 * names a book after its file). ST's `originalData`, a copy of the card book it was made
 * from that goes stale with every edit, isn't kept.
 */
export const importLorebook = (
  bytes: Uint8Array,
  fallbackName = "",
  limits: Limits = defaultLimits,
  authorNote: AuthorNoteLore = DEFAULT_AUTHOR_NOTE_LORE
): Effect.Effect<{ lorebook: LorebookDoc; report: ImportReport }, FormatError> =>
  attempt(() => {
    if (bytes.byteLength > limits.maxFileBytes) {
      fail("file.too_large", `The file is larger than ${formatByteSize(limits.maxFileBytes)}.`)
    }
    const issues = new ReportBuilder()
    const root = parseJson(bytes, limits.maxLorebookJsonBytes, limits, issues)
    if (!Predicate.isObject(root) || !Predicate.isObjectOrArray(root.entries)) {
      return fail("lorebook.not_a_lorebook", "The file isn't a World Info file: it has no entries.")
    }
    const book = new Fields(root, [], issues)
    if (book.has("originalData")) {
      issues.add("info", "lorebook.original_dropped", "ST's copy of the card book this came from was dropped.", [
        "originalData"
      ])
    }
    const listed = Object.entries(root.entries)
    checkEntryCount(listed.length, limits)
    const entries = listed.flatMap(
      ([key, entry], index) => wiEntry(key, !Array.isArray(root.entries), entry, index, issues) ?? []
    )
    return {
      lorebook: {
        schema_version: LOREBOOK_SCHEMA_VERSION,
        name: book.string("name") || fallbackName,
        description: "",
        scan_depth: null,
        token_budget: null,
        recursive_scanning: null,
        extensions: book.object("extensions"),
        entries: assignUids(placeAuthorNoteEntries(entries, authorNote, ["entries"], issues), [], issues),
        ...book.unknown(BOOK_KEYS)
      },
      report: issues.build("st-world-info")
    }
  })

/**
 * Our lorebook as an ST World Info file. Card book fields ST's World Info has no place for
 * (an entry's `name`, `priority` and `use_regex`, the book's settings) are left out, as
 * ST's own conversion leaves them out.
 */
export const exportLorebook = (book: LorebookDoc) => {
  const entries = book.entries.map((entry) => [
    String(entry.uid),
    {
      ...entry.unknown_fields,
      uid: entry.uid,
      key: entry.keys,
      keysecondary: entry.secondary_keys,
      comment: entry.comment,
      content: entry.content,
      constant: entry.constant,
      vectorized: entry.vectorized,
      selective: entry.selective,
      selectiveLogic: LOGICS.indexOf(entry.selective_logic),
      addMemo: entry.add_memo,
      order: entry.order,
      position: POSITIONS.indexOf(entry.position),
      disable: !entry.enabled,
      ignoreBudget: entry.ignore_budget,
      excludeRecursion: entry.exclude_recursion,
      preventRecursion: entry.prevent_recursion,
      matchPersonaDescription: entry.match_persona_description,
      matchCharacterDescription: entry.match_character_description,
      matchCharacterPersonality: entry.match_character_personality,
      matchCharacterDepthPrompt: entry.match_character_depth_prompt,
      matchScenario: entry.match_scenario,
      matchCreatorNotes: entry.match_creator_notes,
      delayUntilRecursion: entry.delay_until_recursion,
      probability: entry.probability,
      useProbability: entry.use_probability,
      depth: entry.depth,
      outletName: entry.outlet_name,
      group: entry.group,
      groupOverride: entry.group_override,
      groupWeight: entry.group_weight,
      scanDepth: entry.scan_depth,
      caseSensitive: entry.case_sensitive,
      matchWholeWords: entry.match_whole_words,
      useGroupScoring: entry.use_group_scoring,
      automationId: entry.automation_id,
      role: ROLES.indexOf(entry.role),
      sticky: entry.sticky,
      cooldown: entry.cooldown,
      delay: entry.delay,
      ...present({
        characterFilter: entry.character_filter && {
          isExclude: entry.character_filter.is_exclude,
          names: entry.character_filter.names,
          tags: entry.character_filter.tags
        },
        displayIndex: entry.display_index
      }),
      triggers: entry.triggers,
      extensions: withOurFields(entry)
    }
  ])
  const file = {
    ...book.unknown_fields,
    ...present({ name: book.name || undefined }),
    ...(Object.keys(book.extensions).length > 0 ? { extensions: book.extensions } : {}),
    entries: Object.fromEntries(entries)
  }
  return new TextEncoder().encode(JSON.stringify(file, null, 4))
}
