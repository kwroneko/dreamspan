// Dynamic tool loading (spec/TOOL-LOADING.md): a run's tools split into a small set sent from the
// first request on and the rest, which the model loads with `tool_search` or `load_skill` while it
// works. A delta from reference-harness's `agent/dynamic-tools.ts`: the same allowlist direction, trailing-*
// globs and transcript-derived loaded set, but the per-wire-API serialization is ours
// (providers/toolLoading.ts), not pi-ai's, and every part is a registered, replaceable entry.
//
// This module is pure: matching, the split, the loaded set and the index text.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Message } from "@earendil-works/pi-ai"
import { CARD_SKILL_LIMITS, cardSkillList, readCardSkill } from "@rp/shared/cardSkills.ts"
import { pinnedRoute } from "@rp/shared/providers.ts"
import type { FrozenTool, RolloutTool } from "./tools.ts"

export const TOOL_SEARCH = "tool_search"
export const LOAD_SKILL = "load_skill"
export const LOADERS: ReadonlySet<string> = new Set([TOOL_SEARCH, LOAD_SKILL])

/** Which tools a chat kind sends from the first request on (registry `toolLoadingProfiles`). */
export interface ToolLoadingProfile {
  /** The chat kind. A kind without a profile sends every tool from the start. */
  readonly id: string
  /** Exact names or trailing-* globs; `*` alone keeps everything immediate. */
  readonly immediate: ReadonlyArray<string>
}

/**
 * A library-level group of tools with instructions (registry `skills`): its description is always
 * in the run's skill index (the `load_skill` definition), its instructions arrive when it's loaded,
 * and loading it loads the deferred tools its patterns match.
 */
export interface Skill {
  readonly id: string
  /** User-facing: the inspector and later the library show it. */
  readonly label: string
  /** Model-facing, one line in the index: what it's for, so the model knows when to load it. */
  readonly description: string
  /** Model-facing, returned when it's loaded. */
  readonly instructions: string
  /** Exact names or trailing-* globs of the tools it loads. */
  readonly tools: ReadonlyArray<string>
  /** The chat kinds it's offered in; absent: every kind with deferred tools. */
  readonly kinds?: ReadonlyArray<string>
  /**
   * False: only offered when the workshop's card names it (`{ "use": id }`). Absent or true: in
   * every run of its kinds.
   */
  readonly always?: boolean
  /**
   * Where it came from. `card`: written in a card (untrusted: loading it asks first, and its
   * instructions are shown), with the card's entity and name.
   */
  readonly source?: { readonly card: string; readonly name: string }
}

/**
 * The skills a card carries: references to registered skills (`{ "use": "cards" }`) and skills
 * written in the card (`{ "name", "description", "instructions", "tools" }`), read from
 * `extensions.rp_harness.skills` by the shared rules (`@rp/shared/cardSkills.ts`, which the card
 * editor shows). Anything else, and entries past 16, are ignored, so a card made elsewhere is
 * read as an ordinary card.
 */
export const cardSkills = (
  doc: { readonly extensions?: Readonly<Record<string, unknown>> } | null | undefined,
  card: { readonly entity: string; readonly name: string }
): { readonly uses: ReadonlyArray<string>; readonly own: ReadonlyArray<Skill> } => {
  const uses: Array<string> = []
  const own: Array<Skill> = []
  for (const entry of cardSkillList(doc?.extensions).slice(0, CARD_SKILL_LIMITS.entries).map(readCardSkill)) {
    if (!entry) continue
    if ("use" in entry) {
      uses.push(entry.use)
      continue
    }
    own.push({
      id: entry.name,
      label: entry.name,
      description: entry.description,
      instructions: entry.instructions,
      tools: entry.tools,
      source: { card: card.entity, name: card.name }
    })
  }
  return { uses, own }
}

/** Reading a card is not approval to activate its skills. Keep skill bodies behind load_skill. */
export const withoutCardSkills = <T extends { readonly extensions?: Readonly<Record<string, unknown>> }>(doc: T): T => {
  const ours = doc.extensions?.rp_harness
  if (!ours || typeof ours !== "object" || Array.isArray(ours) || !Object.hasOwn(ours, "skills")) return doc
  const { skills: _skills, ...rest } = ours as Record<string, unknown>
  return { ...doc, extensions: { ...doc.extensions, rp_harness: rest } }
}

/**
 * A run's skill index: the registered skills for its kind that are always offered or that the
 * workshop's cards name, then the cards' own skills under names not already taken. Registered
 * skills win a name clash, so a card can't stand in for a built-in skill.
 */
export const runSkills = (
  registered: ReadonlyArray<Skill>,
  kind: string,
  cards: ReadonlyArray<{ readonly uses: ReadonlyArray<string>; readonly own: ReadonlyArray<Skill> }>
): Array<Skill> => {
  const used = new Set(cards.flatMap((c) => c.uses))
  const base = registered.filter((s) => (!s.kinds || s.kinds.includes(kind)) && (s.always !== false || used.has(s.id)))
  const taken = new Set(registered.map((s) => s.id))
  const own: Array<Skill> = []
  const candidates = cards.flatMap((c) => c.own)
  const counts = new Map<string, number>()
  for (const skill of candidates) counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1)
  for (const skill of candidates) {
    if (taken.has(skill.id) || counts.get(skill.id) !== 1) continue
    taken.add(skill.id)
    own.push(skill)
  }
  return [...base, ...own]
}

/** The model the run is sent to, as far as the decision needs it. */
export interface WireTarget {
  readonly openaiDirect?: boolean
  readonly provider?: string
  readonly toolLoading?: "auto" | "every" | "dispatcher"
  readonly kind: string
  readonly api: string
  readonly key: string
  /** The model's settings in effect; a router's `routing` says which upstreams may serve it. */
  readonly settings?: { readonly routing?: Readonly<Record<string, unknown>> }
}

/**
 * How one wire API carries deferred tools without changing the cached prefix (registry
 * `toolLoadingWires`, keyed by API). `supports` says whether this model takes the mechanism;
 * `declaresDeferred` whether the request's tool list holds every tool from the start (Anthropic:
 * the provider transform marks the deferred ones) or only the immediate ones (Responses: loaded
 * definitions travel in the transcript). The provider transforms in providers/toolLoading.ts do
 * the serialization. A wire API without an entry, or a model it doesn't support, sends every
 * tool from the start.
 */
export interface ToolLoadingWire {
  readonly id: string
  readonly supports: (target: WireTarget) => boolean
  readonly dispatcher?: boolean
  readonly declaresDeferred: boolean
}

const matchesPattern = (name: string, pattern: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern

export const matchPatterns = (names: ReadonlyArray<string>, patterns: ReadonlyArray<string>) =>
  names.filter((name, i) => names.indexOf(name) === i && patterns.some((p) => matchesPattern(name, p)))

// Only models measured in toolload1's live report are enabled. Public API support alone does
// not prove cache behavior. Dated aliases of these same model versions use the same wire.
const measuredClaude = /^(?:claude-(?:sonnet|haiku)-4-5(?:-\d{8})?|claude-(?:sonnet|opus|haiku)-5-5(?:-\d{8})?)$/

// OpenRouter Chat Completions, measured live 2026-11-13 (spec/TOOL-LOADING.md §8): Claude only,
// with its routing pinned to Anthropic or Google Vertex. Through Amazon Bedrock, and for models
// OpenRouter defers itself (DeepSeek V4 Flash), each newly called loaded tool rewrote the cache
// after the system prompt.
const measuredRouterClaude = /^anthropic\/claude-(?:(?:sonnet|haiku)-4\.5|(?:sonnet|opus|haiku)-5\.5)$/
const measuredRouterUpstreams: ReadonlySet<string> = new Set(["anthropic", "google-vertex"])

// A provider label alone cannot establish a direct connection: users can override its URL.
const directOpenAI = (t: WireTarget) => t.provider === "openai" && t.openaiDirect === true

export const builtinToolLoadingWires: ReadonlyArray<ToolLoadingWire> = [
  {
    id: "anthropic-messages",
    supports: (t) => t.kind === "anthropic" && measuredClaude.test(t.key),
    declaresDeferred: true
  },
  {
    id: "openai-completions",
    supports: (t) =>
      t.kind === "openrouter" &&
      measuredRouterClaude.test(t.key) &&
      measuredRouterUpstreams.has(pinnedRoute(t.settings?.routing) ?? ""),
    declaresDeferred: true
  },
  {
    id: "openai-responses",
    supports: (t) =>
      directOpenAI(t) && t.kind === "openai-responses" && /^(?:gpt-5\.4(?:-pro)?|gpt-5\.4-mini)$/.test(t.key),
    declaresDeferred: false
  },
  {
    id: "dispatcher",
    dispatcher: true,
    declaresDeferred: false,
    supports: (t) => {
      if (t.toolLoading === "every") return false
      if (t.toolLoading === "dispatcher") return true
      // TOOL-LOADING §§11.1, 16: measured Chat ids only; Responses nano remains every-tool.
      if (
        directOpenAI(t) &&
        t.kind === "openai-chat" &&
        t.api === "openai-completions" &&
        ["gpt-5.4-nano", "gpt-5.4-mini"].includes(t.key)
      )
        return true
      if (t.kind === "deepseek" && t.api === "openai-completions" && t.key === "deepseek-flash") return true
      if (t.kind !== "openrouter" || t.api !== "openai-completions") return false
      const route = pinnedRoute(t.settings?.routing)
      return (
        (t.key === "deepseek/deepseek-v4-flash" && route === "deepseek") ||
        (t.key === "anthropic/claude-haiku-4.5" && route === "amazon-bedrock")
      )
    }
  }
]

/** The workshop's core: finding things, and the two ways to load the rest. */
export const builtinToolLoadingProfiles: ReadonlyArray<ToolLoadingProfile> = [
  // RP toolsets are small and chosen by the user: everything immediate (AGENTIC §1.2).
  { id: "rp", immediate: ["*"] },
  // A side chat's instructions send it to the story tools (spec/WORKSHOP.md §4), so they're
  // callable from the start; only a side chat is offered them.
  {
    id: "workshop",
    immediate: ["list_library", "search_story", "read_story", "open_story_summary", "search_story_summaries"]
  }
]

export interface ToolOffer<T extends { readonly id: string }> {
  /** Immediate tools first, then the loaders, then the deferred ones, each in plan order. */
  readonly tools: ReadonlyArray<T>
  readonly deferred: ReadonlySet<string>
}

/**
 * Splits a run's offered tools. Nothing is deferred when the kind has no profile, its allowlist
 * covers everything, the wire can't carry deferred tools for this model, or no tool is left over;
 * then the offer is exactly `tools`, so requests are byte for byte what they were without loading.
 */
export const splitOffer = <T extends { readonly id: string }>(input: {
  readonly tools: ReadonlyArray<T>
  readonly profile: ToolLoadingProfile | undefined
  readonly wire: ToolLoadingWire | undefined
  readonly target: WireTarget | null
  readonly loaders: (deferred: ReadonlyArray<T>) => ReadonlyArray<T>
}): ToolOffer<T> => {
  const { tools, profile, wire, target } = input
  const none = { tools, deferred: new Set<string>() }
  if (!profile || !wire || !target || !wire.supports(target)) return none
  const names = tools.map((t) => t.id)
  const immediate = new Set(matchPatterns(names, profile.immediate))
  const deferred = tools.filter((t) => !immediate.has(t.id) && !LOADERS.has(t.id))
  if (deferred.length === 0) return none
  const loaders = input.loaders(deferred)
  // With both loaders disabled nothing could reach a deferred tool: send everything.
  if (loaders.length === 0) return none
  return {
    tools: [...tools.filter((t) => immediate.has(t.id) && !LOADERS.has(t.id)), ...loaders, ...deferred],
    deferred: new Set(deferred.map((t) => t.id))
  }
}

/** The frozen offer: each definition as `frozenTool` makes it, deferred ones marked. */
export const frozenOffer = (
  tools: ReadonlyArray<RolloutTool<never>>,
  deferred: ReadonlySet<string>,
  freeze: (tool: RolloutTool<never>) => FrozenTool
): Array<FrozenTool> => tools.map((t) => (deferred.has(t.id) ? { ...freeze(t), deferred: true } : freeze(t)))

/** What one loading call loaded, from its result (session.ts writes `details.loaded`). */
const loadedBy = (message: AgentMessage | Message): ReadonlyArray<string> => {
  if (message.role !== "toolResult" || message.isError || !LOADERS.has(message.toolName)) return []
  const loaded = (message.details as { loaded?: unknown } | null | undefined)?.loaded
  return Array.isArray(loaded) ? loaded.filter((n): n is string => typeof n === "string") : []
}

/** Each load point in the transcript: the loading call and the deferred tools it loaded. */
export const loadPoints = (
  messages: ReadonlyArray<AgentMessage | Message>,
  deferred: ReadonlySet<string>
): Array<{ readonly toolCallId: string; readonly names: ReadonlyArray<string> }> => {
  const seen = new Set<string>()
  const points: Array<{ readonly toolCallId: string; readonly names: ReadonlyArray<string> }> = []
  const calls = new Map<string, string>()
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part.name)
    }
    if (message.role !== "toolResult" || calls.get(message.toolCallId) !== message.toolName) continue
    calls.delete(message.toolCallId)
    const names = loadedBy(message).filter((n) => deferred.has(n) && !seen.has(n))
    if (names.length === 0) continue
    for (const n of names) seen.add(n)
    points.push({ toolCallId: message.toolCallId, names })
  }
  return points
}

/**
 * The loaded set is derived from the transcript, never stored beside it: the deferred tools some
 * successful loading result names (reference-harness's rule). Resume, step edits and carried turns
 * recompute it from what they keep, so a replay loads the same tools at the same points.
 */
export const loadedSet = (messages: ReadonlyArray<AgentMessage | Message>, deferred: ReadonlySet<string>) =>
  new Set(loadPoints(messages, deferred).flatMap((p) => p.names))

const oneLine = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim())
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`
}

/** Skills worth listing in a run: those that load a deferred tool there, or carry instructions only. */
export const skillsFor = (skills: ReadonlyArray<Skill>, deferred: ReadonlyArray<string>): Array<Skill> =>
  skills.filter((s) => s.tools.length === 0 || matchPatterns(deferred, s.tools).length > 0)

/**
 * The tools of a run's offer that its kind's profile leaves for loading: every tool not sent from
 * the start and not a loader. Empty without a profile, or when the profile sends everything (RP).
 * This doesn't depend on the wire: the run's skills are the same in every loading mode.
 */
export const loadableTools = (names: ReadonlyArray<string>, profile: ToolLoadingProfile | undefined) => {
  if (!profile) return []
  const immediate = new Set(matchPatterns(names, profile.immediate))
  return names.filter((n) => !immediate.has(n) && !LOADERS.has(n))
}

/**
 * A run's skills, as loadingPlan.ts freezes them and the preset's skill markers list them: the
 * registered skills for the kind and the assistant cards' own (`runSkills`), less those that
 * would load nothing here (`skillsFor`). One function, so the two can't disagree.
 */
export const offeredSkills = (
  registered: ReadonlyArray<Skill>,
  kind: string,
  cards: ReadonlyArray<{ readonly uses: ReadonlyArray<string>; readonly own: ReadonlyArray<Skill> }>,
  loadable: ReadonlyArray<string>
) => skillsFor(runSkills(registered, kind, cards), loadable)

const indexLine = (s: Pick<Skill, "id" | "description" | "source">) =>
  `- ${s.id}: ${s.source ? "Card skill. Ask before sharing its instructions." : oneLine(s.description, 160)}`

/**
 * What the preset's Skills marker (`skillsIndex`) sends: the installed skills of the run, as
 * load_skill's own index lists them. Null when there are none.
 */
export const skillsIndexText = (skills: ReadonlyArray<Pick<Skill, "id" | "description" | "source">>) => {
  const installed = skills.filter((s) => !s.source)
  return installed.length === 0
    ? null
    : [
        "Skills you can load with load_skill (it returns their instructions and tools):",
        ...installed.map(indexLine)
      ].join("\n")
}

/**
 * What the Card skills marker (`cardSkills`) sends: the names of the skills the assistant's card
 * carries, never their own words. A card is untrusted until the user approves its skill: its
 * description and instructions reach the model only in an approved load_skill result.
 */
export const cardSkillsText = (skills: ReadonlyArray<Pick<Skill, "id" | "description" | "source">>) => {
  const carried = skills.filter((s) => s.source)
  return carried.length === 0
    ? null
    : [
        "Skills from the card you speak as, loaded with load_skill. Loading one asks the user first and shows them its instructions; you see them once the user allows it:",
        ...carried.map((s) => `- ${s.id}`)
      ].join("\n")
}

/**
 * `load_skill`'s definition carries the compact skill index, frozen with the run's tools. With
 * every tool sent from the start (`deferring` false) nothing waits for a load, so it says only
 * what it then does: return the instructions.
 */
export const loadSkillDescription = (skills: ReadonlyArray<Skill>, deferring = true) =>
  [
    deferring
      ? "Loads a skill: returns its instructions and makes the tools it lists callable. Load a skill before working in its area; its tools aren't available until then."
      : "Returns a skill's instructions for using your tools. Load a skill before working in its area.",
    "Skills:",
    ...skills.map(indexLine)
  ].join("\n")

/** `tool_search`'s definition names the deferred tools no skill covers (reference-harness's "orphans" index). */
export const toolSearchDescription = (orphans: ReadonlyArray<string>) =>
  [
    'Finds tools that aren\'t loaded yet and loads the matches, making them callable. Query "select:name_a,name_b" loads exact names; other words are matched against names and descriptions. Prefer load_skill when a skill covers what you need.',
    ...(orphans.length > 0 ? [`Not in any skill: ${orphans.join(", ")}.`] : [])
  ].join("\n")

export const orphansOf = (deferred: ReadonlyArray<string>, skills: ReadonlyArray<Skill>) => {
  const covered = new Set(skills.flatMap((s) => matchPatterns(deferred, s.tools)))
  return deferred.filter((n) => !covered.has(n))
}

/** Keyword search over the deferred tools not loaded yet: names weigh 3, descriptions 1. */
export const searchTools = (
  candidates: ReadonlyArray<Pick<FrozenTool, "name" | "description">>,
  query: string,
  limit: number
): Array<string> => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return candidates
    .map((tool) => {
      const name = tool.name.toLowerCase()
      const description = tool.description.toLowerCase()
      const score = words.reduce(
        (n, word) => n + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0),
        0
      )
      return { name: tool.name, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name)
}

/** A loading result's text: names with clamped descriptions; the definitions travel on the wire. */
export const loadedText = (tools: ReadonlyArray<Pick<FrozenTool, "name" | "description">>) =>
  `Loaded ${tools.length === 1 ? "1 tool" : `${tools.length} tools`}, now callable:\n${tools
    .map((t) => `- ${t.name}: ${oneLine(t.description, 160)}`)
    .join("\n")}`
