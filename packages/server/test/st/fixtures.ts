// Synthetic fixtures for the ST harness. Every name and line here is made up.
//
// Cards and lorebooks go through our own importers and exporters on the way to ST
// (ARCHITECTURE §8), so ST reading them back also checks those exporters. Presets are the
// parser tests' fixtures, used as they are.
import { readFileSync } from "node:fs"
import { exportCardPng } from "../../src/formats/cardExport.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { exportLorebook, importLorebook } from "../../src/formats/worldInfo.ts"
import { json, png, run } from "../formats/support.ts"

interface ChatLine {
  readonly name: string
  readonly is_user: boolean
  readonly mes: string
}

export interface FixtureSet {
  readonly persona: { readonly name: string; readonly description: string }
  /** Card PNGs, as our exporter writes them. */
  readonly cards: ReadonlyArray<{ readonly name: string; readonly png: Uint8Array }>
  /** World Info files, as our exporter writes them. ST names a book after its file. */
  readonly lorebooks: ReadonlyArray<{ readonly name: string; readonly file: Uint8Array }>
  readonly presets: ReadonlyArray<{ readonly name: string; readonly data: unknown }>
  /** One chat per card, by card name; its greeting comes first. */
  readonly chats: ReadonlyArray<{ readonly card: string; readonly lines: ReadonlyArray<ChatLine> }>
  /**
   * Text from the card, persona and lorebook that ST's request must carry, macros expanded,
   * when the chat's last message mentions the lantern.
   */
  readonly expectedInPrompt: ReadonlyArray<string>
}

const PERSONA = { name: "Tobin", description: "{{user}} is a cartographer who distrusts maps drawn by others." }
const CARD = "Mira Vance"
const LORE = "Saltmarsh Lore"

const cardPng = () => {
  const { card } = run(
    importCard(
      json({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: CARD,
          description: "{{char}} keeps the tide ledger of Saltmarsh and owes {{user}} a favor.",
          personality: "Dry, exact, quietly kind.",
          scenario: "{{user}} arrives at the ledger house during a spring flood.",
          first_mes: "*{{char}} looks up from the ledger.* You're late, {{user}}.",
          mes_example: "<START>\n{{user}}: Is the causeway open?\n{{char}}: Until the eleventh bell.",
          creator_notes: "Synthetic fixture for the ST harness.",
          system_prompt: "",
          post_history_instructions: "",
          tags: ["fixture"],
          creator: "rp-harness",
          character_version: "1",
          alternate_greetings: [],
          extensions: {
            talkativeness: "0.5",
            fav: false,
            world: LORE,
            depth_prompt: { prompt: "{{char}} never guesses a tide.", depth: 2, role: "system" }
          }
        }
      })
    )
  )
  return run(exportCardPng(card, png()))
}

const lorebook = () => {
  const { lorebook } = run(
    importLorebook(
      json({
        entries: {
          "0": {
            uid: 0,
            key: [],
            comment: "the town",
            content: "Saltmarsh floods every spring; the ledger records each tide.",
            constant: true,
            order: 100,
            position: 0
          },
          "1": {
            uid: 1,
            key: ["lantern"],
            comment: "the lantern",
            content: "The green lantern on the causeway is lit only when the tide turns.",
            order: 50,
            position: 1
          },
          "2": {
            uid: 2,
            key: ["bell"],
            comment: "the bells",
            content: "The eleventh bell closes the causeway.",
            order: 10,
            position: 4,
            depth: 1,
            role: 0
          }
        }
      }),
      LORE
    )
  )
  return exportLorebook(lorebook)
}

const presetFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/presets/${name}.json`, import.meta.url), "utf8"))

const PRESET_FIXTURES = ["default", "full", "legacy"] as const

export const fixtureSet = (): FixtureSet => ({
  persona: PERSONA,
  cards: [{ name: CARD, png: cardPng() }],
  lorebooks: [{ name: LORE, file: lorebook() }],
  presets: PRESET_FIXTURES.map((name) => ({ name, data: presetFixture(name) })),
  chats: [
    {
      card: CARD,
      lines: [
        { name: CARD, is_user: false, mes: "*Mira looks up from the ledger.* You're late, Tobin." },
        { name: PERSONA.name, is_user: true, mes: "The causeway was already under water." },
        { name: CARD, is_user: false, mes: "Then the tide came early. Write that down... no, I will." },
        { name: PERSONA.name, is_user: true, mes: "Someone lit a lantern out there." }
      ]
    }
  ],
  expectedInPrompt: [
    "Tobin is a cartographer who distrusts maps drawn by others.",
    "Mira Vance keeps the tide ledger of Saltmarsh and owes Tobin a favor.",
    "Dry, exact, quietly kind.",
    "Tobin arrives at the ledger house during a spring flood.",
    "Is the causeway open?",
    "Until the eleventh bell.",
    "Mira Vance never guesses a tide.",
    "Saltmarsh floods every spring; the ledger records each tide.",
    "The green lantern on the causeway is lit only when the tide turns."
  ]
})
