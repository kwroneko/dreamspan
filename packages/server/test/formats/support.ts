// Synthetic fixtures and helpers for the format parser tests. Every card here is made up.
import { Effect } from "effect"
import type { FormatError } from "../../src/formats/safety.ts"

export const run = <A>(effect: Effect.Effect<A, FormatError>): A => Effect.runSync(effect)

/** The `FormatError` code an effect fails with. */
export const failure = <A>(effect: Effect.Effect<A, FormatError>): string => Effect.runSync(Effect.flip(effect)).code

export const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

/** A V2 card as ST exports it: V1 copies and its local state next to `data`. */
export const stCardV2 = () => ({
  name: "Wren",
  description: "A lighthouse keeper.",
  personality: "Patient.",
  scenario: "A storm night.",
  first_mes: "The lamp needs oil.",
  mes_example: "<START>\n{{char}}: Mind the stairs.",
  creatorcomment: "Made for testing.",
  avatar: "none",
  chat: "Wren - 2026-01-01@12h00m00s",
  talkativeness: "0.5",
  fav: false,
  tags: ["sea"],
  create_date: "2026-01-01T12:00:00.000Z",
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Wren",
    description: "A lighthouse keeper.",
    personality: "Patient.",
    scenario: "A storm night.",
    first_mes: "The lamp needs oil.",
    mes_example: "<START>\n{{char}}: Mind the stairs.",
    creator_notes: "Made for testing.",
    system_prompt: "Stay in character.",
    post_history_instructions: "Keep replies short.",
    tags: ["sea"],
    creator: "tester",
    character_version: "1.2",
    alternate_greetings: ["Another storm.", "Fog again."],
    extensions: {
      talkativeness: "0.5",
      fav: false,
      world: "Hollowmere",
      depth_prompt: { prompt: "Wren smells of oil.", depth: 4, role: "system" },
      "some-plugin": { mood: "calm", nested: { level: 2 } }
    },
    character_book: {
      name: "Hollowmere",
      scan_depth: 3,
      extensions: { "some-plugin": true },
      entries: [
        {
          id: 7,
          keys: ["lighthouse", "lamp"],
          secondary_keys: ["storm"],
          comment: "the lighthouse",
          content: "The lighthouse is old.",
          constant: false,
          selective: true,
          insertion_order: 50,
          enabled: true,
          position: "before_char",
          use_regex: true,
          extensions: {
            position: 4,
            depth: 2,
            role: 1,
            selectiveLogic: 3,
            probability: 80,
            useProbability: true,
            group: "places",
            sticky: 2,
            delay_until_recursion: 1,
            display_index: 0,
            triggers: ["normal"],
            "some-plugin": { weight: 1 }
          }
        },
        { keys: ["Wren"], content: "Wren is tall.", insertion_order: 10, enabled: true, position: "after_char" }
      ]
    },
    an_unknown_field: { kept: true }
  },
  some_root_field: 42
})

/** A V3 card with the V3-only fields. */
export const cardV3 = () => ({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "Moss",
    description: "A gardener.",
    personality: "",
    scenario: "",
    first_mes: "Hello.",
    mes_example: "",
    creator_notes: "Notes.",
    creator_notes_multilingual: { en: "Notes.", fr: "Notes en français." },
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    group_only_greetings: ["Hello, everyone."],
    nickname: "Mossy",
    source: ["https://example.com/moss"],
    tags: ["garden"],
    creator: "tester",
    character_version: "3",
    creation_date: 1_700_000_000,
    modification_date: 1_700_000_100,
    assets: [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }],
    extensions: {}
  }
})
