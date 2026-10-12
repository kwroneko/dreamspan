import type { LorebookDoc, LorebookEntry } from "@rp/shared/docs/lorebook.ts"
export const loreEntry = (fields: Partial<LorebookEntry> = {}, uid = 0): LorebookEntry => ({
  uid,
  keys: [],
  secondary_keys: [],
  comment: "",
  content: "",
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
  add_memo: false,
  use_regex: false,
  extensions: {},
  ...fields
})
export const loreBook = (
  entries: ReadonlyArray<LorebookEntry>,
  fields: Partial<LorebookDoc> = {},
  id = "synthetic"
) => ({
  id,
  document: {
    schema_version: 1,
    name: id,
    description: "",
    scan_depth: null,
    token_budget: null,
    recursive_scanning: null,
    extensions: {},
    entries,
    ...fields
  } satisfies LorebookDoc
})

/** Every kept ST position, plus primary, secondary, constant and depth activation. */
export const gateLore = loreBook(
  [
    loreEntry({ keys: ["crossing"], content: "A copper bell marks the crossing.", order: 200 }),
    loreEntry(
      {
        keys: ["crossing"],
        secondary_keys: ["tonight"],
        selective_logic: "and_all",
        content: "Tonight the ferry carries lanterns.",
        position: "after_char"
      },
      1
    ),
    loreEntry(
      { constant: true, content: "The ferry keeper counts every passenger.", position: "after_char", order: 50 },
      2
    ),
    loreEntry(
      { keys: ["crossing"], content: "Check the river gauge.", position: "at_depth", depth: 1, role: "user" },
      3
    ),
    loreEntry(
      { constant: true, content: "A watchman keeps the upper bank.", position: "at_depth", depth: 1, role: "system" },
      4
    ),
    loreEntry({ constant: true, content: "The lower bank is dark.", position: "an_top" }, 5),
    loreEntry({ constant: true, content: "The upper bank has lanterns.", position: "an_bottom" }, 6),
    loreEntry(
      {
        constant: true,
        content: "<START>\n{{user}}: Are boats safe?\n{{char}}: Stay near the bank.",
        position: "em_top"
      },
      7
    ),
    loreEntry(
      {
        constant: true,
        content: "<START>\n{{user}}: What of the current?\n{{char}}: Keep the rope taut.",
        position: "em_bottom"
      },
      8
    ),
    loreEntry(
      {
        keys: ["crossing"],
        secondary_keys: ["tonight"],
        selective_logic: "not_any",
        content: "THIS SHOULD NOT BE SENT."
      },
      9
    )
  ],
  {},
  "st-diff assembly lore"
)
