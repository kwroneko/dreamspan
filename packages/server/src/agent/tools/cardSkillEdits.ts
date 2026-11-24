import {
  CARD_SKILL_LIMITS as limits,
  CARD_SKILL_NAME,
  CARD_SKILLS_NAMESPACE,
  cardSkillProblems,
  readCardSkill,
  type CardSkillEntry
} from "@dreamspan/shared/cardSkills.ts"
import { Type, type Static } from "@earendil-works/pi-ai"
import { canonicalJson } from "@dreamspan/shared/editing.ts"
import { BAD_ARGS, fitsTool } from "../dispatcher.ts"

const strict = { additionalProperties: false } as const
const name = Type.String({ pattern: CARD_SKILL_NAME.source, maxLength: limits.name })
const skill = Type.Union([
  Type.Object(
    {
      name,
      description: Type.String({ minLength: 1, maxLength: limits.description }),
      instructions: Type.String({ minLength: 1, maxLength: limits.instructions }),
      tools: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: limits.tool }), { maxItems: limits.tools })
      )
    },
    strict
  ),
  Type.Object({ use: name }, strict)
])
export const cardSkillChange = Type.Object(
  {
    field: Type.Literal("skills"),
    action: Type.Union([Type.Literal("add"), Type.Literal("edit"), Type.Literal("remove")]),
    name: Type.Optional(name),
    skill: Type.Optional(skill)
  },
  strict
)
export type CardSkillChange = Static<typeof cardSkillChange>

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const id = (entry: CardSkillEntry) => ("use" in entry ? entry.use : entry.name)

/** Refuse raw skill changes that the tool validator would have to coerce. */
export const validateCardSkillArguments = (args: unknown) => {
  if (!isObject(args) || !Array.isArray(args.changes)) return
  for (const change of args.changes) {
    if (!isObject(change) || change.field !== "skills") continue
    if (!fitsTool({ name: "edit_card", description: "Edit a card skill", parameters: cardSkillChange }, change))
      return BAD_ARGS
    if (change.skill !== undefined) {
      const problems = cardSkillProblems(change.skill, 0)
      if (problems.length > 0) return problems.join(" ")
    }
  }
}

/** Edit only the named entry, preserving the rest of the card's extensions and skills. */
export const changeCardSkill = (extensions: unknown, change: CardSkillChange) => {
  const { action, name, skill } = change
  if (action === "add" ? name !== undefined : name === undefined)
    return { error: "Give the existing name for edit or remove. For add, put the name inside skill." }
  if (action === "remove" ? skill !== undefined : skill === undefined)
    return { error: "Give a skill for add or edit. For remove, give only its existing name." }
  if (!isObject(extensions)) return { error: "This card's extensions aren't an object." }
  const namespace = extensions[CARD_SKILLS_NAMESPACE]
  if (namespace !== undefined && !isObject(namespace))
    return { error: "This card's Dreamspan extension isn't an object." }
  const saved = namespace?.skills
  if (saved !== undefined && !Array.isArray(saved)) return { error: "This card's skills aren't stored as a list." }
  const list: Array<unknown> = [...(saved ?? [])]
  const entries = list.map(readCardSkill)
  const matches = (name: string) => entries.flatMap((entry, index) => (entry && id(entry) === name ? [index] : []))
  let index = list.length
  if (name !== undefined) {
    const found = matches(name)
    if (found.length === 0) return { error: `This card has no skill named ${name}.` }
    if (found.length > 1)
      return { error: `More than one skill is named ${name}. Resolve that in the card editor first.` }
    index = found[0]!
  }

  let next: CardSkillEntry | null = null
  if (skill !== undefined) {
    if (index >= limits.entries) return { error: `A card can have at most ${limits.entries} skills.` }
    const problems = cardSkillProblems(skill, index)
    if (problems.length > 0) return { error: problems.join(" ") }
    next = readCardSkill(skill)
    if (!next) return { error: "Give the skill a valid name and content, or an installed skill id in use." }
    if (matches(id(next)).some((at) => at !== index))
      return { error: `This card already has a skill named ${id(next)}.` }
  }

  const before = entries[index] ?? null
  if (canonicalJson(list[index] ?? null) === canonicalJson(next)) return { extensions }
  list.splice(index, 1, ...(next ? [next] : []))
  return {
    extensions: { ...extensions, [CARD_SKILLS_NAMESPACE]: { ...namespace, skills: list } },
    preview: {
      field: `skills (${name ?? id(next!)})`,
      before: before ? JSON.stringify(before, null, 2) : "",
      after: next ? JSON.stringify(next, null, 2) : ""
    }
  }
}
