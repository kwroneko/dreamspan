// The lorebook document (DATA-MODEL §3.3): one shape for standalone lorebooks and a
// card's embedded `character_book`. Entry fields follow SillyTavern's World Info entries,
// whose semantics imported lorebooks keep (DESIGN §1.3), in snake_case.
import { Schema } from "effect"

export const LOREBOOK_SCHEMA_VERSION = 1

export const CharacterFilter = Schema.Struct({
  is_exclude: Schema.Boolean,
  names: Schema.Array(Schema.String),
  cards: Schema.optionalKey(Schema.Array(Schema.Struct({ entity: Schema.String, name: Schema.String }))),
  tags: Schema.Array(Schema.String),
  tag_ids: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
})

const Extensions = Schema.Record(Schema.String, Schema.Unknown)

/**
 * ST's `world_info_position` but its 2 and 3, before and after the author's note, which the
 * harness doesn't have (owner, 2026-11-01): an import places those entries at a depth.
 */
export const LorePosition = Schema.Literals(["before_char", "after_char", "at_depth", "em_top", "em_bottom", "outlet"])
export type LorePosition = typeof LorePosition.Type

/** ST's `world_info_logic`: how secondary keys combine with a primary match. */
export const SelectiveLogic = Schema.Literals(["and_any", "not_all", "not_any", "and_all"])
export type SelectiveLogic = typeof SelectiveLogic.Type

export const LoreRole = Schema.Literals(["system", "user", "assistant"])
export type LoreRole = typeof LoreRole.Type

/** Where our assembler places an entry instead of its ST position (DESIGN §1.3), as notes do. */
export const PlacementOverride = Schema.Struct({
  mode: Schema.Literals(["tail", "depth", "section"]),
  depth: Schema.optionalKey(Schema.Int)
})

export const LorebookEntry = Schema.Struct({
  /** Unique within the book; the three-way merge matches entries by it. */
  uid: Schema.Int,
  keys: Schema.Array(Schema.String),
  secondary_keys: Schema.Array(Schema.String),
  comment: Schema.String,
  content: Schema.String,
  constant: Schema.Boolean,
  selective: Schema.Boolean,
  selective_logic: SelectiveLogic,
  enabled: Schema.Boolean,
  /** Card books call it `insertion_order`. */
  order: Schema.Finite,
  position: LorePosition,
  depth: Schema.Int,
  role: LoreRole,
  outlet_name: Schema.String,
  probability: Schema.Finite,
  use_probability: Schema.Boolean,
  group: Schema.String,
  group_override: Schema.Boolean,
  group_weight: Schema.Finite,
  use_group_scoring: Schema.NullOr(Schema.Boolean),
  scan_depth: Schema.NullOr(Schema.Int),
  case_sensitive: Schema.NullOr(Schema.Boolean),
  match_whole_words: Schema.NullOr(Schema.Boolean),
  sticky: Schema.NullOr(Schema.Int),
  cooldown: Schema.NullOr(Schema.Int),
  delay: Schema.NullOr(Schema.Int),
  exclude_recursion: Schema.Boolean,
  prevent_recursion: Schema.Boolean,
  /** ST takes a flag or a recursion level. */
  delay_until_recursion: Schema.Union([Schema.Boolean, Schema.Int]),
  ignore_budget: Schema.Boolean,
  vectorized: Schema.Boolean,
  automation_id: Schema.String,
  triggers: Schema.Array(Schema.String),
  match_persona_description: Schema.Boolean,
  match_character_description: Schema.Boolean,
  match_character_personality: Schema.Boolean,
  match_character_depth_prompt: Schema.Boolean,
  match_scenario: Schema.Boolean,
  match_creator_notes: Schema.Boolean,
  add_memo: Schema.Boolean,
  display_index: Schema.optionalKey(Schema.Int),
  /** Filenames not resolved on import stay in names; resolved cards retain their export filename. */
  character_filter: Schema.optionalKey(CharacterFilter),
  /** Card book fields with no World Info equivalent. */
  name: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Schema.Finite),
  use_regex: Schema.Boolean,
  /** Ours: a question for a decision model about whether the entry is relevant. */
  decision_hint: Schema.optionalKey(Schema.String),
  placement_override: Schema.optionalKey(PlacementOverride),
  /** The entry's `extensions`, verbatim, with plugin namespaces (PLUGINS §3.3). */
  extensions: Extensions,
  /** Keys the source format doesn't define, kept so an export writes them back. */
  unknown_fields: Schema.optionalKey(Extensions)
})
export type LorebookEntry = typeof LorebookEntry.Type

export const LorebookDoc = Schema.Struct({
  schema_version: Schema.Literal(LOREBOOK_SCHEMA_VERSION),
  name: Schema.String,
  description: Schema.String,
  scan_depth: Schema.NullOr(Schema.Int),
  token_budget: Schema.NullOr(Schema.Int),
  recursive_scanning: Schema.NullOr(Schema.Boolean),
  extensions: Extensions,
  entries: Schema.Array(LorebookEntry),
  unknown_fields: Schema.optionalKey(Extensions)
})
export type LorebookDoc = typeof LorebookDoc.Type

/** The same ordinary entry defaults for the editor and workshop tools. */
export const newLorebookEntry = (uid: number): LorebookEntry => ({
  uid,
  keys: [],
  secondary_keys: [],
  comment: "",
  content: "",
  constant: false,
  selective: false,
  selective_logic: "and_any",
  enabled: true,
  order: 100,
  position: "after_char",
  depth: 4,
  role: "system",
  outlet_name: "",
  probability: 100,
  use_probability: true,
  group: "",
  group_override: false,
  group_weight: 100,
  use_group_scoring: null,
  scan_depth: null,
  case_sensitive: null,
  match_whole_words: null,
  sticky: null,
  cooldown: null,
  delay: null,
  exclude_recursion: false,
  prevent_recursion: false,
  delay_until_recursion: false,
  ignore_budget: false,
  vectorized: false,
  automation_id: "",
  triggers: [],
  match_persona_description: false,
  match_character_description: false,
  match_character_personality: false,
  match_character_depth_prompt: false,
  match_scenario: false,
  match_creator_notes: false,
  add_memo: false,
  use_regex: false,
  extensions: {}
})
