import { modelName } from "@dreamspan/shared/cardNames.ts"
// The Definitions marker's card blocks (DESIGN §5.0, §5.2, §5.3; ARCHITECTURE §15).
import type { Names } from "./macros.ts"
import { type Assembly, need } from "./pipeline.ts"
import type { Text } from "./st.ts"
import type { CardInput } from "./types.ts"

type CardText = (assembly: Assembly, card: CardInput, field: keyof CardInput["doc"], names?: Partial<Names>) => Text

/** Wraps a card's part in the preset's join prefix and suffix (`<Name>…</Name>` by default). */
type Wrap = (card: CardInput, label: string, id: string, body: ReadonlyArray<Text>) => Text | null

/** A card's parts joined with blank lines, then wrapped like every cast card's part (DESIGN §5.0). */
const block = (assembly: Assembly, card: CardInput, wrap: Wrap, parts: ReadonlyArray<Text>): Text | null => {
  const env = need(assembly, "macros")
  const present = parts.filter((part) => part.text)
  if (present.length === 0) return null
  const text = present.map((part) => part.text).join("\n\n")
  const body = env.verbatim(
    `layout:definitions:${card.entity}`,
    { kind: "assembler", what: `${modelName(card.doc)}'s definitions` },
    text,
    // A skipped conditioned note's empty part stays among the pieces: it keeps the block volatile.
    parts.map((part) => part.piece)
  )
  return wrap(card, "Definitions", "definitions", [{ text, piece: body }])
}

/** A character's notes placed with its definitions, then its description, personality and scenario. */
export const cardBlock = (
  assembly: Assembly,
  card: CardInput,
  cardText: CardText,
  wrap: Wrap,
  top: ReadonlyArray<Text> = []
): Text | null => {
  const own = { char: modelName(card.doc) }
  return block(assembly, card, wrap, [
    ...top,
    cardText(assembly, card, "description", own),
    cardText(assembly, card, "personality", own),
    cardText(assembly, card, "scenario", own)
  ])
}

/** A persona's notes placed with its definitions, then its description. */
export const personaBlock = (
  assembly: Assembly,
  card: CardInput,
  cardText: CardText,
  wrap: Wrap,
  top: ReadonlyArray<Text> = []
): Text | null =>
  block(assembly, card, wrap, [...top, cardText(assembly, card, "description", { user: modelName(card.doc) })])
