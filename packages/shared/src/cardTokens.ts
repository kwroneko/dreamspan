// A card's token counts, as ST shows them at the top of its character panel
// (public/scripts/RossAscends-mods.js `RA_CountCharTokens` and the counters in public/index.html):
// "permanent" is what every request carries (the name, description, personality and scenario;
// ST also counts its Character's Note, which is a card note here, not a card field), and
// "total" adds the first message, the example messages, and the card's system prompt and
// post-history instructions. Alternate greetings aren't counted, as in ST. A token is the
// app's estimate wherever there's no tokenizer: four characters (`estimateTokens` in the
// server's assembler/st.ts), so these are estimates, as ST's own tooltip says of its counts.
import { modelName } from "./cardNames.ts"
import type { Doc } from "./library.ts"

export const estimateTextTokens = (text: string) => Math.ceil(text.length / 4)

/** The card's text fields ST counts, and whether each is in every request. */
const CARD_TOKEN_FIELDS: ReadonlyArray<{ readonly field: string; readonly permanent: boolean }> = [
  { field: "description", permanent: true },
  { field: "personality", permanent: true },
  { field: "scenario", permanent: true },
  { field: "first_mes", permanent: false },
  { field: "mes_example", permanent: false },
  { field: "system_prompt", permanent: false },
  { field: "post_history_instructions", permanent: false }
]

const text = (value: unknown) => (typeof value === "string" ? value : "")

export interface CardTokenCounts {
  readonly total: number
  readonly permanent: number
}

export const cardTokenCounts = (doc: Doc): CardTokenCounts => {
  const name = estimateTextTokens(modelName({ name: text(doc.name), nickname: text(doc.nickname) }))
  let total = name
  let permanent = name
  for (const { field, permanent: always } of CARD_TOKEN_FIELDS) {
    const tokens = estimateTextTokens(text(doc[field]))
    total += tokens
    if (always) permanent += tokens
  }
  return { total, permanent }
}
