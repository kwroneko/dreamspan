// A card's skills (spec/TOOL-LOADING.md §6), in `extensions.dreamspan.skills`: references to an
// installed skill (`{ "use": "id" }`) and skills written in the card. The server reads them with
// these rules when a workshop's assistant is the card; the card editor shows the same rules, so
// an entry that isn't offered says why instead of being skipped silently.

/** Where a card keeps them: our extension namespace, which other apps keep and ignore. */
export const CARD_SKILLS_NAMESPACE = "dreamspan"

export const CARD_SKILL_LIMITS = {
  entries: 16,
  name: 48,
  description: 300,
  instructions: 8000,
  tools: 64,
  tool: 64
} as const

/** A skill's name: lower-case letters, digits, `-` and `_`, starting with a letter or digit. */
export const CARD_SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/

interface OwnCardSkill {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly tools: ReadonlyArray<string>
}

export type CardSkillEntry = { readonly use: string } | OwnCardSkill

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined

/** The raw list a card's extensions hold, or none. */
export const cardSkillList = (extensions: Readonly<Record<string, unknown>> | null | undefined) => {
  const ours = extensions?.[CARD_SKILLS_NAMESPACE]
  const list = ours && typeof ours === "object" ? (ours as { skills?: unknown }).skills : undefined
  return Array.isArray(list) ? (list as ReadonlyArray<unknown>) : []
}

/** One entry as the server reads it: a reference, a skill of the card's own, or nothing (ignored). */
export const readCardSkill = (entry: unknown): CardSkillEntry | null => {
  if (!entry || typeof entry !== "object") return null
  const e = entry as Record<string, unknown>
  const use = text(e.use, CARD_SKILL_LIMITS.name)
  if (use && CARD_SKILL_NAME.test(use)) return { use }
  const name = text(e.name, CARD_SKILL_LIMITS.name)
  const description = text(e.description, CARD_SKILL_LIMITS.description)
  const instructions = text(e.instructions, CARD_SKILL_LIMITS.instructions)
  if (!name || !CARD_SKILL_NAME.test(name) || !description || !instructions) return null
  const tools = Array.isArray(e.tools)
    ? e.tools
        .filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= CARD_SKILL_LIMITS.tool)
        .slice(0, CARD_SKILL_LIMITS.tools)
    : []
  return { name, description, instructions, tools }
}

/**
 * What the editor says about an entry the server would skip or shorten, in the user's words;
 * empty when it's used as written. `index` is its place in the list (from 0). It follows
 * `readCardSkill` step for step, so what it says is what the server does.
 */
export const cardSkillProblems = (entry: unknown, index: number): ReadonlyArray<string> => {
  if (index >= CARD_SKILL_LIMITS.entries) return [`Only the first ${CARD_SKILL_LIMITS.entries} skills are used.`]
  if (!entry || typeof entry !== "object") return ["Not a skill: it's skipped."]
  const e = entry as Record<string, unknown>
  const long = (value: unknown) => typeof value === "string" && value.length > CARD_SKILL_LIMITS.name
  const shortened = `Only the first ${CARD_SKILL_LIMITS.name} characters of its name are used.`
  const read = readCardSkill(entry)
  if (read && "use" in read) return long(e.use) ? [shortened] : []
  const problems: Array<string> = []
  const name = text(e.name, CARD_SKILL_LIMITS.name)
  if (name === undefined && text(e.use, CARD_SKILL_LIMITS.name) !== undefined)
    return ["Not a skill's name: it's skipped."]
  if (name === undefined || !CARD_SKILL_NAME.test(name))
    problems.push("Skipped until its name is 1–48 lower-case letters, digits, - or _, starting with a letter or digit.")
  else if (long(e.name)) problems.push(shortened)
  if (text(e.description, CARD_SKILL_LIMITS.description) === undefined)
    problems.push("Skipped until it says what it's for.")
  else if ((e.description as string).length > CARD_SKILL_LIMITS.description)
    problems.push(`Only the first ${CARD_SKILL_LIMITS.description} characters of what it's for are used.`)
  if (text(e.instructions, CARD_SKILL_LIMITS.instructions) === undefined)
    problems.push("Skipped until it has instructions.")
  else if ((e.instructions as string).length > CARD_SKILL_LIMITS.instructions)
    problems.push(
      `Only the first ${CARD_SKILL_LIMITS.instructions.toLocaleString("en")} characters of its instructions are used.`
    )
  const tools = Array.isArray(e.tools) ? e.tools : []
  const named = tools.filter((t) => typeof t === "string" && t.length > 0 && t.length <= CARD_SKILL_LIMITS.tool)
  if (named.length < tools.length)
    problems.push(`Tool names over ${CARD_SKILL_LIMITS.tool} characters, and anything that isn't a name, are left out.`)
  if (named.length > CARD_SKILL_LIMITS.tools) problems.push(`Only its first ${CARD_SKILL_LIMITS.tools} tools are used.`)
  return problems
}

/** Whether the server reads the entry as a reference to an installed skill (`{ "use": "id" }`). */
export const isSkillReference = (entry: unknown): entry is { readonly use: string } => {
  const read = readCardSkill(entry)
  if (read) return "use" in read
  if (!entry || typeof entry !== "object") return false
  const e = entry as Record<string, unknown>
  return text(e.use, CARD_SKILL_LIMITS.name) !== undefined && text(e.name, CARD_SKILL_LIMITS.name) === undefined
}

/** Names more than one of a card's own skills have: none of them is offered. */
export const duplicateSkillNames = (list: ReadonlyArray<unknown>): ReadonlySet<string> => {
  const counts = new Map<string, number>()
  for (const entry of list.slice(0, CARD_SKILL_LIMITS.entries).map(readCardSkill))
    if (entry && "name" in entry) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name))
}
