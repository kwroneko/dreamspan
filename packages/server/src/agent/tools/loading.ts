// The loading tools (spec/TOOL-LOADING.md §4): `tool_search` and `load_skill`. Both are reads: they
// change nothing outside the run, so they need no capability and are never asked first. Loading
// never grants anything: a loaded tool runs through the same offered-tools check, receipts,
// capability standing and approvals as one sent from the start, and only tools already in the
// run's frozen offer can be loaded (an Off capability's tools aren't in it). A delta from
// reference-harness's `tools/tool-search.ts` and `tools/load-skill.ts`: skills are registered entries,
// not files, and the result's `loaded` names are what the wire layer serializes as the load point.
import { Type } from "@earendil-works/pi-ai"
import { Effect } from "effect"
import type { Registry } from "../../registry.ts"
import { LOAD_SKILL, loadedText, matchPatterns, searchTools, type Skill, TOOL_SEARCH } from "../toolLoading.ts"
import type { RolloutTool, ToolContext, ToolOutput } from "../tools.ts"

const MAX_RESULTS = 5

const notActive: ToolOutput = {
  text: "Nothing is left to load in this run: every tool is already available.",
  isError: true
}

/** The deferred tools of the run's offer that aren't loaded yet. */
const pending = (context: ToolContext) =>
  (context.offer?.tools ?? []).filter((t) => t.deferred === true && !context.offer!.loaded.has(t.name))

const load = (context: ToolContext, names: ReadonlyArray<string>) => {
  const offered = context.offer?.tools ?? []
  const loaded = context.offer?.loaded ?? new Set<string>()
  const added = offered.filter((t) => t.deferred === true && names.includes(t.name) && !loaded.has(t.name))
  const already = names.filter((n) => loaded.has(n) || offered.some((t) => t.name === n && t.deferred !== true))
  return { added, already }
}

export const toolSearch: RolloutTool<{ readonly query: string; readonly max_results?: number }> = {
  id: TOOL_SEARCH,
  label: "Looked for tools",
  explanation: "Find and load tools the assistant doesn't have yet.",
  effect: "read",
  description: "Finds tools that aren't loaded yet and loads them.",
  parameters: Type.Object({
    query: Type.String({ description: 'Either "select:<name>[,<name>…]" for exact names, or keywords.' }),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Keywords only. Default 5." }))
  }),
  summarize: ({ query }) => query,
  execute: (context, { query, max_results }) =>
    Effect.sync((): ToolOutput => {
      if (!context.offer || !context.offer.tools.some((t) => t.deferred === true)) return notActive
      const trimmed = query.trim()
      const selecting = trimmed.toLowerCase().startsWith("select:")
      const requested = selecting
        ? trimmed
            .slice("select:".length)
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean)
        : searchTools(pending(context), trimmed, max_results ?? MAX_RESULTS)
      const { added, already } = load(context, requested)
      const unknown = selecting ? requested.filter((n) => !context.offer!.tools.some((t) => t.name === n)) : []
      const parts = [
        ...(added.length ? [loadedText(added)] : []),
        ...(already.length ? [`Already available: ${already.join(", ")}.`] : []),
        ...(unknown.length ? [`Not available in this chat: ${unknown.join(", ")}.`] : [])
      ]
      if (parts.length === 0) {
        const left = pending(context).map((t) => t.name)
        parts.push(
          left.length
            ? `No tool matched "${trimmed}". Not loaded yet: ${left.join(", ")}. Try other words, or load_skill.`
            : "Every tool is already loaded."
        )
      }
      return { text: parts.join("\n\n"), ...(added.length ? { loaded: added.map((t) => t.name) } : {}) }
    })
}

/** A card's own skills are untrusted: loading one asks first (spec/TOOL-LOADING.md §6). */
export const CARD_SKILLS = "skills.card"

/** The skills a call may load: the registered ones for the kind, then the workshop cards' own. */
const availableSkills = (skills: Pick<Registry<Skill>, "list">, context: ToolContext) => {
  const kind = context.offer?.kind ?? ""
  const registered = skills.list().filter((s) => !s.kinds || s.kinds.includes(kind))
  const taken = new Set(registered.map((s) => s.id))
  return [...registered, ...(context.offer?.cardSkills ?? []).filter((s) => !taken.has(s.id))]
}

export const makeLoadSkill = (
  skills: Pick<Registry<Skill>, "get" | "list">
): RolloutTool<{ readonly name: string }> => ({
  id: LOAD_SKILL,
  label: "Loaded a skill",
  explanation: "Load a group of tools with instructions for using them.",
  effect: "read",
  description: "Loads a skill: its instructions and tools.",
  parameters: Type.Object({
    name: Type.String({ description: "The skill's name exactly as the list above gives it." })
  }),
  titleField: "name",
  summarize: ({ name }) => name,
  capabilityFor: (context, { name }) =>
    availableSkills(skills, context).find((s) => s.id === name)?.source ? CARD_SKILLS : undefined,
  // What the user is shown before a card's skill is first used: its own words and what it loads.
  describe: (context, { name }) =>
    Effect.sync(() => {
      const skill = availableSkills(skills, context).find((s) => s.id === name)
      const tools = skill
        ? matchPatterns(
            (context.offer?.tools ?? []).map((t) => t.name),
            skill.tools
          )
        : []
      return {
        title: skill?.source
          ? `Use the skill “${skill.id}” from the card ${skill.source.name}`
          : `Use the skill “${name}”`,
        rows: [
          { label: "What it says", value: skill?.description ?? "" },
          { label: "Instructions", value: skill?.instructions ?? "" },
          { label: "Tools it loads", value: tools.length ? tools.join(", ") : "None" }
        ]
      }
    }),
  execute: (context, { name }) =>
    Effect.sync((): ToolOutput => {
      if (!context.offer) return notActive
      const available = availableSkills(skills, context)
      const skill = available.find((s) => s.id === name)
      if (!skill)
        return {
          text: `There's no skill "${name}". Skills: ${available.map((s) => s.id).join(", ") || "none"}.`,
          isError: true
        }
      const names = matchPatterns(
        context.offer.tools.map((t) => t.name),
        skill.tools
      )
      const { added, already } = load(context, names)
      const parts = [
        `<skill name="${skill.id}">\n${skill.instructions}\n</skill>`,
        ...(added.length ? [loadedText(added)] : []),
        ...(already.length ? [`Already available: ${already.join(", ")}.`] : []),
        ...(names.length === 0 ? ["This skill has instructions only; it adds no tools here."] : [])
      ]
      return { text: parts.join("\n\n"), ...(added.length ? { loaded: added.map((t) => t.name) } : {}) }
    })
})
