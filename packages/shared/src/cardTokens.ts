// A card's token counts, as ST shows them at the top of its character panel (SillyTavern
// public/scripts/RossAscends-mods.js `RA_CountCharTokens`, and the `data-token-counter` /
// `data-token-permanent` counters in public/index.html): each counted field on its own, summed.
// "Permanent" (`data-token-permanent`) is the name, description, personality, scenario and the
// Character's Note (ST's depth prompt; here a card's notes on in every chat by default, a linked
// one with its shared note's text); "total" adds the first message, the example messages, and
// the card's system prompt and post-history instructions. Alternate greetings and creator's
// notes aren't counted, as in ST. Each text is counted as chats send it (owner, 2026-11-02:
// the counts include exactly what's sent): trimmed, as the assembler trims every card field and
// note, and with macros substituted (the editor's `countMacros.ts`). The counts come from the
// chat model's tokenizer (the client's tokenCounts.ts, ARCHITECTURE §6 "Text tokens"), so any
// counter can sum them.
import { modelName } from "./cardNames.ts"
import type { Doc } from "./library.ts"

/** The card's text fields ST counts, in its panel's order, and whether each is in every request. */
const CARD_TOKEN_FIELDS: ReadonlyArray<{ readonly field: string; readonly permanent: boolean }> = [
  { field: "description", permanent: true },
  { field: "first_mes", permanent: false },
  { field: "system_prompt", permanent: false },
  { field: "post_history_instructions", permanent: false },
  { field: "personality", permanent: true },
  { field: "scenario", permanent: true },
  { field: "mes_example", permanent: false }
]

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

export interface CardTokenText {
  readonly text: string
  readonly permanent: boolean
}

/** What ST counts for a card: the name chats send, its fields, and the notes on by default. */
export const cardTokenTexts = (doc: Doc, notes: ReadonlyArray<string> = []): ReadonlyArray<CardTokenText> => [
  { text: modelName({ name: text(doc.name), nickname: text(doc.nickname) }), permanent: true },
  ...CARD_TOKEN_FIELDS.map(({ field, permanent }) => ({ text: text(doc[field]), permanent })),
  ...notes.map((note) => ({ text: note.trim(), permanent: true }))
]

export interface CardTokenCounts {
  readonly total: number
  readonly permanent: number
}

/** Sums each text's count (`counts[i]` for `texts[i]`) into ST's total and permanent. */
export const sumCardTokens = (texts: ReadonlyArray<CardTokenText>, counts: ReadonlyArray<number>): CardTokenCounts => {
  let total = 0
  let permanent = 0
  for (const [i, { permanent: always }] of texts.entries()) {
    const tokens = counts[i] ?? 0
    total += tokens
    if (always) permanent += tokens
  }
  return { total, permanent }
}
