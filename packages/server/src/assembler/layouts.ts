import { modelName } from "@rp/shared/cardNames.ts"
// Our layouts' card blocks (DESIGN §5.2, §5.3; ARCHITECTURE §15).
import type { Names } from "./macros.ts"
import { type Assembly, need } from "./pipeline.ts"
import type { Text } from "./st.ts"
import type { CardInput } from "./types.ts"

type CardText = (assembly: Assembly, card: CardInput, field: keyof CardInput["doc"], names?: Partial<Names>) => Text

const label = (name: string) => name.replace(/"/g, "'")

const block = (assembly: Assembly, tag: string, card: CardInput, parts: ReadonlyArray<Text>): Text => {
  const env = need(assembly, "macros")
  const present = parts.filter((part) => part.text)
  const text = `<${tag} name="${label(modelName(card.doc))}">\n${present.map((part) => part.text).join("\n\n")}\n</${tag}>`
  const piece = env.verbatim(
    `layout:${tag}:${card.entity}`,
    { kind: "assembler", what: `${tag} block` },
    text,
    present.map((part) => part.piece)
  )
  return { text, piece }
}

/** A character's description, personality and scenario, in that order, labelled with its name. */
export const cardBlock = (
  assembly: Assembly,
  card: CardInput,
  cardText: CardText,
  top: ReadonlyArray<Text> = []
): Text => {
  const own = { char: modelName(card.doc) }
  return block(assembly, "character", card, [
    ...top,
    cardText(assembly, card, "description", own),
    cardText(assembly, card, "personality", own),
    cardText(assembly, card, "scenario", own)
  ])
}

/** A persona's notes and its description unless placed elsewhere, labelled with its name. */
export const personaBlock = (
  assembly: Assembly,
  card: CardInput,
  cardText: CardText,
  top: ReadonlyArray<Text> = []
): Text | null => {
  const parts = [
    ...top,
    ...(assembly.placedPersonas?.has(card.entity)
      ? []
      : [cardText(assembly, card, "description", { user: modelName(card.doc) })])
  ]
  return parts.some((part) => part.text) ? block(assembly, "persona", card, parts) : null
}
