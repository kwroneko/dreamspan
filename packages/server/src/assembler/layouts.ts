import { modelName } from "@rp/shared/cardNames.ts"
// The Definitions marker's card blocks and the group nudge (DESIGN §5.0, §5.2, §5.3; ARCHITECTURE §15).
import type { Names } from "./macros.ts"
import { type Assembly, need } from "./pipeline.ts"
import type { Text } from "./st.ts"
import type { CardInput } from "./types.ts"

type CardText = (assembly: Assembly, card: CardInput, field: keyof CardInput["doc"], names?: Partial<Names>) => Text
type PresetText = (assembly: Assembly, id: string, text: string, names?: Partial<Names>) => Text

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

/**
 * The tail directive (DESIGN §5.3): the preset's own group nudge naming the speaker, sent
 * when there's more than one character to choose from.
 */
export const directive = (assembly: Assembly, presetText: PresetText): Text | null => {
  const cast = need(assembly, "cast")
  const utility = need(assembly, "preset").doc.utility_prompts
  const speaker = cast.speaker
  if (!speaker || cast.personas.includes(speaker)) return null
  const text = utility.group_nudge_prompt
  return text ? presetText(assembly, "utility.group_nudge_prompt", text, { char: modelName(speaker.doc) }) : null
}
