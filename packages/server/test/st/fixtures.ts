// Synthetic fixtures for the ST harness. Every name and line here is made up.
//
// Cards and lorebooks go through our own importers and exporters on the way to ST
// (ARCHITECTURE §8), so ST reading them back also checks those exporters. Presets are the
// parser tests' fixtures, each with its round trip through our preset format.
import { readFileSync } from "node:fs"
import { exportCardPng } from "../../src/formats/cardExport.ts"
import { importCard } from "../../src/formats/cardImport.ts"
import { exportStPreset, importStPreset } from "../../src/formats/preset.ts"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"
import { ROLES } from "../../src/formats/lorebook.ts"
import { exportLorebook, importLorebook } from "../../src/formats/worldInfo.ts"
import type { CardFields } from "@rp/shared/macros/context.ts"
import { gateLore } from "../support/loreFixtures.ts"
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
  /** The cards the context assembler is compared on, each with a chat below. */
  readonly gateCards: ReadonlyArray<string>
  /** World Info files, as our exporter writes them. ST names a book after its file. */
  readonly lorebooks: ReadonlyArray<{ readonly name: string; readonly file: Uint8Array }>
  readonly presets: ReadonlyArray<{ readonly name: string; readonly data: unknown }>
  /** Pairs of presets above: a file, and the same file imported and exported by us. */
  readonly presetRoundTrips: ReadonlyArray<{
    readonly name: string
    readonly roundTripName: string
    /** How many issues our import reported. */
    readonly issues: number
  }>
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

/** The card's text fields, macros unexpanded. */
const CARD_TEXT = {
  description: "{{char}} keeps the tide ledger of Saltmarsh and owes {{user}} a favor.",
  personality: "Dry, exact, quietly kind.",
  scenario: "{{user}} arrives at the ledger house during a spring flood.",
  first_mes: "*{{char}} looks up from the ledger.* You're late, {{user}}.",
  mes_example: "<START>\n{{user}}: Is the causeway open?\n{{char}}: Until the eleventh bell.",
  creator_notes: "Synthetic fixture for the ST harness."
}

const DEPTH_PROMPT = "{{char}} never guesses a tide."
const CARD_VERSION = "1"

/** When every fixture chat message was sent, as ST stores it and as epoch milliseconds (UTC). */
export const CHAT_SEND_DATE = "January 1, 2026 12:00am"
export const CHAT_SENT_AT = Date.UTC(2026, 0, 1)

/** The fixture card as ST's macros read it, with the persona's description. */
export const MACRO_CARD: CardFields = {
  description: CARD_TEXT.description,
  personality: CARD_TEXT.personality,
  scenario: CARD_TEXT.scenario,
  persona: PERSONA.description,
  mesExamples: CARD_TEXT.mes_example,
  systemPrompt: "",
  postHistoryInstructions: "",
  depthPrompt: DEPTH_PROMPT,
  creatorNotes: CARD_TEXT.creator_notes,
  version: CARD_VERSION,
  firstMessage: CARD_TEXT.first_mes,
  alternateGreetings: []
}

const cardPng = () => {
  const { card } = run(
    importCard(
      json({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: CARD,
          ...CARD_TEXT,
          system_prompt: "",
          post_history_instructions: "",
          tags: ["fixture"],
          creator: "rp-harness",
          character_version: CARD_VERSION,
          alternate_greetings: [],
          extensions: {
            talkativeness: "0.5",
            fav: false,
            world: LORE,
            depth_prompt: { prompt: DEPTH_PROMPT, depth: 2, role: "system" }
          }
        }
      })
    )
  )
  return run(exportCardPng(card, png()))
}

/**
 * The context assembler's fixtures (ARCHITECTURE §15): cards without a lorebook, since
 * matching ST's lorebooks isn't a goal (DESIGN §1.3). Oren has a prompt override, post-history
 * instructions, two example blocks and a Character's Note in the user's role; Wren has none
 * of them, and no personality.
 */
const GATE_CARDS = [
  {
    name: "Oren Hale",
    description: "{{char}} runs the night ferry across the estuary and owes {{user}} nothing.",
    personality: "Gruff, honest, superstitious.",
    scenario: "{{user}} needs passage before the fog closes in.",
    first_mes: "*{{char}} coils a rope.* Ferry's closing, {{user}}.",
    mes_example:
      "<START>\n{{user}}: How much for a crossing?\n{{char}}: More than you have.\n<START>\n{{user}}: Is it safe?\n{{char}}: Nothing on this water is safe.",
    system_prompt: "{{original}}\nKeep {{char}}'s replies short and dry.",
    post_history_instructions: "Write only {{char}}'s next reply.",
    depth_prompt: { prompt: "{{char}} never takes payment in coin.", depth: 1, role: "user" }
  },
  {
    name: "Wren Ash",
    description: "{{char}} keeps bees on the old sea wall.",
    personality: "",
    scenario: "Late summer, after the storms.",
    first_mes: "*{{char}} lifts a frame of comb.* Careful, {{user}}.",
    mes_example: "",
    system_prompt: "",
    post_history_instructions: "",
    depth_prompt: undefined
  }
] as const

const gatePng = (card: (typeof GATE_CARDS)[number]) => {
  const { depth_prompt, ...fields } = card
  const { card: doc } = run(
    importCard(
      json({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          ...fields,
          creator_notes: "",
          tags: ["fixture"],
          creator: "rp-harness",
          character_version: "1",
          alternate_greetings: [],
          extensions: { talkativeness: "0.5", fav: false, ...(depth_prompt ? { depth_prompt } : {}) }
        }
      })
    )
  )
  return run(exportCardPng(doc, png()))
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

/** The parser tests' preset fixtures, each with its round trip (ARCHITECTURE §9). */
const presetRoundTrips = () =>
  ["default", "full", "legacy", "rewrite"].map((name) => {
    const text = readFileSync(new URL(`../fixtures/presets/${name}.json`, import.meta.url), "utf8")
    const { document, report } = importStPreset(text)
    if (document === null) throw new Error(`fixture preset ${name} doesn't import`)
    return {
      name,
      original: JSON.parse(text) as unknown,
      roundTripName: `${name} (round trip)`,
      roundTrip: exportStPreset(document),
      issues: report.issues.length
    }
  })

/**
 * A book as ST's World Info file, its entries at ST's author's note (positions 2 and 3) kept
 * there: our export writes them at a depth, as the harness places them (owner, 2026-11-01), but
 * the gate compares what ST does with ST's own positions to what our import makes of them.
 */
export const stWorldFile = (book: LorebookDoc) => {
  const file = JSON.parse(new TextDecoder().decode(exportLorebook(book))) as {
    entries: Record<string, Record<string, unknown>>
  }
  for (const entry of book.entries)
    if (entry.position === "an_top" || entry.position === "an_bottom")
      file.entries[String(entry.uid)] = {
        ...file.entries[String(entry.uid)],
        position: entry.position === "an_top" ? 2 : 3,
        depth: entry.depth,
        role: ROLES.indexOf(entry.role)
      }
  return new TextEncoder().encode(JSON.stringify(file, null, 4))
}

export const fixtureSet = (): FixtureSet => {
  const roundTrips = presetRoundTrips()
  return {
    persona: PERSONA,
    cards: [{ name: CARD, png: cardPng() }, ...GATE_CARDS.map((card) => ({ name: card.name, png: gatePng(card) }))],
    gateCards: GATE_CARDS.map((card) => card.name),
    lorebooks: [
      { name: LORE, file: lorebook() },
      { name: gateLore.id, file: stWorldFile(gateLore.document) }
    ],
    presets: roundTrips.flatMap((preset) => [
      { name: preset.name, data: preset.original },
      { name: preset.roundTripName, data: preset.roundTrip }
    ]),
    presetRoundTrips: roundTrips.map(({ name, roundTripName, issues }) => ({ name, roundTripName, issues })),
    chats: [
      {
        card: CARD,
        lines: [
          { name: CARD, is_user: false, mes: "*Mira looks up from the ledger.* You're late, Tobin." },
          { name: PERSONA.name, is_user: true, mes: "The causeway was already under water." },
          { name: CARD, is_user: false, mes: "Then the tide came early. Write that down... no, I will." },
          { name: PERSONA.name, is_user: true, mes: "Someone lit a lantern out there." }
        ]
      },
      {
        card: "Oren Hale",
        lines: [
          { name: "Oren Hale", is_user: false, mes: "*Oren Hale coils a rope.* Ferry's closing, Tobin." },
          { name: PERSONA.name, is_user: true, mes: "One crossing. I can pay." },
          {
            name: "Oren Hale",
            is_user: false,
            // The full preset's prompt-only regex script strips this from the prompt.
            mes: "*He spits over the rail.* <thinking>He wants coin.</thinking>Not in coin, you can't."
          }
        ]
      },
      {
        card: "Wren Ash",
        lines: [
          { name: "Wren Ash", is_user: false, mes: "*Wren Ash lifts a frame of comb.* Careful, Tobin." },
          { name: PERSONA.name, is_user: true, mes: "They're calm today." },
          { name: "Wren Ash", is_user: false, mes: "Calm is when they're planning something." },
          { name: PERSONA.name, is_user: true, mes: "Planning what?" },
          { name: "Wren Ash", is_user: false, mes: "*She smiles.* Honey, mostly." }
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
  }
}
