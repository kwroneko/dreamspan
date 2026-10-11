import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CardDoc } from "../src/docs/card.ts"
import { LorebookDoc } from "../src/docs/lorebook.ts"

const entry = {
  uid: 0,
  keys: ["Hollowmere"],
  secondary_keys: [],
  comment: "the town",
  content: "Hollowmere is a fishing town.",
  constant: false,
  selective: true,
  selective_logic: "and_any",
  enabled: true,
  order: 100,
  position: "before_char",
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
  add_memo: true,
  use_regex: false,
  decision_hint: "Is the scene in or about Hollowmere?",
  extensions: { "some-plugin": { score: 3 } }
}

const book = {
  schema_version: 1,
  name: "Hollowmere",
  description: "",
  scan_depth: null,
  token_budget: null,
  recursive_scanning: null,
  extensions: {},
  entries: [entry]
}

const card = {
  schema_version: 1,
  name: "Wren",
  description: "A lighthouse keeper.",
  personality: "",
  scenario: "",
  first_mes: "The lamp needs oil.",
  mes_example: "",
  alternate_greetings: [],
  group_only_greetings: [],
  system_prompt: "",
  post_history_instructions: "",
  creator_notes: "",
  tags: [],
  creator: "",
  character_version: "",
  avatar_media_id: null,
  character_book: book,
  modules: [{ id: "outfit", title: "Outfit", content: "Oilskin coat.", exportable: false }],
  extensions: { "some-plugin": { mood: "calm" } }
}

describe("library document schemas", () => {
  it("accept a card with an embedded lorebook and keep plugin extensions", () => {
    const decoded = Schema.decodeUnknownSync(CardDoc)(card)
    expect(decoded).toEqual(card)
  })

  it("reject a document of another schema version", () => {
    expect(() => Schema.decodeUnknownSync(LorebookDoc)({ ...book, schema_version: 2 })).toThrow()
    expect(() => Schema.decodeUnknownSync(CardDoc)({ ...card, schema_version: 2 })).toThrow()
  })

  it("reject an entry position ST doesn't have", () => {
    expect(() => Schema.decodeUnknownSync(LorebookDoc)({ ...book, entries: [{ ...entry, position: "top" }] })).toThrow()
  })
})
