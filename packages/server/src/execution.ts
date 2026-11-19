import { historyRenameTool, historySearchTool, rewriteTools } from "./agent/tools/rewrite.ts"
import { makeOperationTools, type OperationRuntime } from "./agent/operations.ts"
import { builtinOperationExposures } from "./agent/exposures/builtins.ts"
import { paritySkills, paritySkillTools, parityTools } from "./agent/exposures/parity.ts"
import { cardSourceExposures, cardSourcesSkill } from "./agent/exposures/cardSources.ts"
import { rolloutEffectClasses } from "./agent/effects.ts"
import { outsideEffect } from "./agent/effects.ts"
import { capabilityDefaults, workshopCapabilities } from "./agent/capabilities.ts"
import { libraryEditCard, setupTools } from "./agent/tools/setup.ts"
import { chatKinds, type ChatKindProfile } from "@dreamspan/shared/chatKinds.ts"
import { workshopCompactor, type RunCompactor } from "./agent/workshopCompactor.ts"
import { workshopMode } from "./agent/workshop.ts"
import { libraryTools } from "./agent/tools/library.ts"
import { defaultReplyStrategy, type ReplyStrategy } from "./chat/replyStrategy.ts"
import { agentReplyStrategy } from "./agent/strategy.ts"
import { historyTools, storyTools } from "./agent/tools/history.ts"
import { runTools, workshopHistoryVariants } from "./agent/tools/runs.ts"
import { editCard } from "./agent/tools/cardEdit.ts"
import { editNote, listNotes, switchNote, writeNote } from "./agent/tools/notes.ts"
import { lookupLore } from "./agent/tools/lore.ts"
import { setPresence } from "./agent/tools/presence.ts"
import {
  agentTool,
  builtinSubagentTypes,
  messageAgentTool,
  storyHelperTool,
  type SubagentType
} from "./agent/subagents.ts"
import { defaultMode, type OrchestrationMode } from "./agent/modes.ts"
import type { RolloutTool } from "./agent/tools.ts"
import type { TurnNote } from "./agent/turnNotes.ts"
import type { PluginWorkingCopy } from "./agent/pluginWorkingCopies.ts"
import {
  builtinToolLoadingProfiles,
  builtinToolLoadingWires,
  type Skill,
  type ToolLoadingProfile,
  type ToolLoadingWire
} from "./agent/toolLoading.ts"
import { builtinSkills } from "./agent/skills.ts"
import { makeLoadSkill, toolSearch } from "./agent/tools/loading.ts"
import { Context, Effect, Layer, Option } from "effect"
import { isReasoningEffort, REASONING_EFFORTS } from "@dreamspan/shared/modelSettings.ts"
import { makeRegistry, type Registry } from "./registry.ts"
import type { SubagentWorkspaces } from "./agent/tools/files.ts"
import { defaultReplyOutput, type ReplyOutputStrategy } from "./chat/replyOutput.ts"
import { replySectionsParser, type ReplyParser } from "./chat/replySections.ts"
import { continueJoinParser } from "./chat/continueJoin.ts"
import { regexLiveRewrite, type LiveRewrite } from "./chat/liveRewrites.ts"
import {
  directSummary,
  toolSummary,
  summaryToolFactory,
  type SummaryStrategy,
  type SummaryToolFactory
} from "./lcm/strategies.ts"

/** Concrete execution policy; persistence, ownership, admission and commits stay in the kernel. */
export class ExecutionRegistry extends Context.Service<
  ExecutionRegistry,
  {
    readonly replyStrategies: Registry<ReplyStrategy>
    readonly replies: Registry<ReplyOutputStrategy>
    /**
     * Stages every reply's chunks go through, in order: Continue's join without a prefill, the
     * leading tagged sections (spec/REPLY-SECTIONS.md).
     */
    readonly replyParsers: Registry<ReplyParser>
    /** What a reply shows while it streams, in order: the scripts its finish runs (liveRewrites.ts). */
    readonly liveRewrites: Registry<LiveRewrite>
    readonly summaries: Registry<SummaryStrategy>
    readonly runCompactors: Registry<RunCompactor>
    readonly summaryTools: Registry<SummaryToolFactory>
    /** Who runs on a turn, what it sees and how its output is taken (spec/AGENTIC.md §6). */
    readonly chatKinds: Registry<ChatKindProfile>
    readonly orchestrationModes: Registry<OrchestrationMode>
    /** The tools an agent turn may offer, with their effect classes (spec/AGENTIC.md §4). */
    readonly effectClasses: typeof rolloutEffectClasses
    readonly workshopCapabilities: typeof workshopCapabilities
    /** The one table of capability defaults (WORKSHOP §10 question 1). */
    readonly capabilityDefaults: typeof capabilityDefaults
    readonly rolloutTools: Registry<RolloutTool<never>>
    readonly operationTools: ReturnType<typeof makeOperationTools>["operationTools"]
    readonly operationTool: ReturnType<typeof makeOperationTools>["operationTool"]
    readonly operationRuntime: OperationRuntime
    readonly kindTools: Registry<{ readonly id: string; readonly tool: RolloutTool<never> }>
    /** Dynamic tool loading (spec/TOOL-LOADING.md): each kind's immediate allowlist. */
    readonly toolLoadingProfiles: Registry<ToolLoadingProfile>
    /** Which wire APIs and models carry deferred tools without changing the cached prefix. */
    readonly toolLoadingWires: Registry<ToolLoadingWire>
    /** Library-level groups of tools with instructions, loaded with `load_skill`. */
    readonly skills: Registry<Skill>
    /** `tool_search` and `load_skill`: offered only in runs that defer a tool. */
    readonly toolLoaders: Registry<RolloutTool<never>>
    /** Lines a workshop turn adds at its tail, in order (agent/turnNotes.ts). */
    readonly turnNotes: Registry<TurnNote>
    /** The kinds of subagents a reply may start (spec/SUBAGENTS.md §2.5, §10); the user's own come from settings. */
    readonly subagentTypes: Registry<SubagentType>
    /** Subagents' working folders and isolated copies (spec/SUBAGENTS.md §3.3): the files host's. */
    readonly subagentWorkspaces: Registry<SubagentWorkspaces>
    /** Where plugin repositories get a working copy the agent's commands can change (agent/pluginWorkingCopies.ts); the first is used. */
    readonly pluginWorkingCopies: Registry<PluginWorkingCopy>
  }
>()("rp/ExecutionRegistry") {
  static readonly layer = Layer.effect(
    ExecutionRegistry,
    Effect.gen(function* () {
      const replyStrategies = makeRegistry<ReplyStrategy>()
      yield* replyStrategies.register(defaultReplyStrategy)
      yield* replyStrategies.register(agentReplyStrategy)
      const orchestrationModes = makeRegistry<OrchestrationMode>()
      yield* orchestrationModes.register(defaultMode)
      const operationRuntime: OperationRuntime = {}
      const { operationTools, operationTool } = makeOperationTools(
        { workshopCapabilities, capabilityDefaults },
        operationRuntime
      )
      for (const entry of [...builtinOperationExposures, ...cardSourceExposures]) yield* operationTools.register(entry)
      yield* orchestrationModes.register({
        ...workshopMode,
        plan: (input) => {
          const plan = workshopMode.plan(input)
          return {
            ...plan,
            tools: [
              ...new Set([
                ...plan.tools,
                ...rewriteTools.map((e) => e.id),
                ...operationTools.list().map((e) => e.id),
                ...parityTools
              ])
            ]
          }
        }
      })
      const validate = (tool: RolloutTool<never>) => {
        if (tool.id === "call_tool") throw new Error("call_tool is reserved for the tool-loading transport.")
        if (
          (outsideEffect(tool.effect) && !tool.capability) ||
          (tool.capability && !workshopCapabilities.get(tool.capability))
        )
          throw new Error(`Tool ${tool.id} needs a registered capability.`)
      }
      const variants = makeRegistry<{ readonly id: string; readonly tool: RolloutTool<never> }>()
      const kindTools = {
        ...variants,
        register: (entry: { readonly id: string; readonly tool: RolloutTool<never> }) =>
          Effect.sync(() => validate(entry.tool)).pipe(Effect.andThen(variants.register(entry)))
      }
      yield* kindTools.register({ id: "workshop:edit_card", tool: libraryEditCard })
      yield* kindTools.register({ id: "workshop:history_rename", tool: historyRenameTool as RolloutTool<never> })
      yield* kindTools.register({ id: "workshop:history_search", tool: historySearchTool as RolloutTool<never> })
      for (const tool of rewriteTools) yield* kindTools.register({ id: `workshop:${tool.id}`, tool })
      for (const variant of workshopHistoryVariants) yield* kindTools.register(variant)
      const catalog = makeRegistry<RolloutTool<never>>()
      const rolloutTools = {
        ...catalog,
        register: (tool: RolloutTool<never>) =>
          Effect.sync(() => validate(tool)).pipe(Effect.andThen(catalog.register(tool)))
      }
      for (const tool of [
        ...historyTools,
        ...storyTools,
        ...runTools,
        ...libraryTools,
        ...setupTools,
        lookupLore,
        listNotes,
        writeNote,
        editNote,
        switchNote,
        setPresence,
        // spec/SUBAGENTS.md SA1: a workshop's child runs; never a story reply's tool.
        agentTool,
        // SA5: messages to the reply's subagents, running or finished.
        messageAgentTool,
        // SA8: the story helper, a story reply's one subagent; off until This chat → Tools allows it.
        storyHelperTool,
        { ...editCard, kindOverrides: ["workshop"] }
      ] as ReadonlyArray<RolloutTool<never>>)
        yield* rolloutTools.register(tool)
      const toolLoadingProfiles = makeRegistry<ToolLoadingProfile>()
      for (const profile of builtinToolLoadingProfiles) yield* toolLoadingProfiles.register(profile)
      const toolLoadingWires = makeRegistry<ToolLoadingWire>()
      for (const wire of builtinToolLoadingWires) yield* toolLoadingWires.register(wire)
      const skills = makeRegistry<Skill>()
      for (const skill of builtinSkills)
        yield* skills.register({ ...skill, tools: [...skill.tools, ...(paritySkillTools[skill.id] ?? [])] })
      for (const skill of paritySkills) yield* skills.register(skill)
      yield* skills.register(cardSourcesSkill)
      const toolLoaders = makeRegistry<RolloutTool<never>>()
      yield* toolLoaders.register(toolSearch as RolloutTool<never>)
      yield* toolLoaders.register(makeLoadSkill() as RolloutTool<never>)
      const typeEntries = makeRegistry<SubagentType>()
      const subagentTypes = {
        ...typeEntries,
        register: (type: SubagentType) =>
          Effect.sync(() => validateSubagentType(type)).pipe(Effect.andThen(typeEntries.register(type)))
      }
      for (const type of builtinSubagentTypes) yield* subagentTypes.register(type)
      const replies = makeRegistry<ReplyOutputStrategy>()
      const summaries = makeRegistry<SummaryStrategy>()
      const runCompactors = makeRegistry<RunCompactor>()
      yield* runCompactors.register(workshopCompactor)
      const summaryTools = makeRegistry<SummaryToolFactory>()
      yield* replies.register(defaultReplyOutput)
      const replyParsers = makeRegistry<ReplyParser>()
      yield* replyParsers.register(continueJoinParser)
      yield* replyParsers.register(replySectionsParser)
      const liveRewrites = makeRegistry<LiveRewrite>()
      yield* liveRewrites.register(regexLiveRewrite)
      yield* summaries.register(directSummary)
      yield* summaries.register(toolSummary)
      yield* summaryTools.register(summaryToolFactory)
      return {
        replyStrategies,
        replies,
        replyParsers,
        liveRewrites,
        summaries,
        runCompactors,
        summaryTools,
        orchestrationModes,
        chatKinds,
        rolloutTools,
        effectClasses: rolloutEffectClasses,
        workshopCapabilities,
        capabilityDefaults,
        kindTools,
        operationTools,
        operationTool,
        operationRuntime,
        toolLoadingProfiles,
        toolLoadingWires,
        skills,
        toolLoaders,
        turnNotes: makeRegistry<TurnNote>(),
        subagentTypes,
        subagentWorkspaces: makeRegistry<SubagentWorkspaces>(),
        pluginWorkingCopies: makeRegistry<PluginWorkingCopy>()
      }
    })
  )
}

/** A subagent type a plugin registers is plain data the agent tool can list and run (spec/SUBAGENTS.md §10). */
const validateSubagentType = (type: SubagentType) => {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(type.id)) throw new Error("A subagent type's id is one lower-case word.")
  if (!type.label?.trim() || !type.instructions?.trim())
    throw new Error("A subagent type needs a label and instructions.")
  if (!Array.isArray(type.kinds) || type.kinds.length === 0) throw new Error("A subagent type names its chat kinds.")
  if (typeof type.tools !== "function" && (typeof type.tools !== "object" || type.tools === null))
    throw new Error("A subagent type's tools are ids or effect classes.")
  if (typeof type.tools === "object") {
    const { ids, effects, all } = type.tools
    if (
      (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) ||
      (effects !== undefined && (!Array.isArray(effects) || effects.some((e) => typeof e !== "string"))) ||
      (all !== undefined && typeof all !== "boolean")
    )
      throw new Error("A subagent type's tools are ids or effect classes.")
  }
  if (type.explanation !== undefined && (typeof type.explanation !== "string" || type.explanation.length > 200))
    throw new Error("A subagent type's explanation is a short sentence, at most 200 characters.")
  if (type.effort !== undefined && !isReasoningEffort(type.effort))
    throw new Error(`A subagent type's effort is one of ${REASONING_EFFORTS.join(", ")}.`)
  if (type.context !== undefined && type.context !== "task" && type.context !== "fork")
    throw new Error("A subagent type's context is task or fork.")
  if (type.isolation !== undefined && type.isolation !== "same" && type.isolation !== "copy")
    throw new Error("A subagent type's isolation is same (the reply's folder) or copy (its own copy).")
}

/** Standalone service construction uses the same scoped defaults as the server. */
export const executionRegistry = Effect.gen(function* () {
  const current = yield* Effect.serviceOption(ExecutionRegistry)
  if (Option.isSome(current)) return current.value
  const context = yield* Layer.build(ExecutionRegistry.layer)
  return Context.get(context, ExecutionRegistry)
})

/** A kind may replace an ambiguous public tool name without changing story semantics. */
export const toolForKind = (
  registry: ExecutionRegistry["Service"],
  kind: string,
  name: string
): RolloutTool<never> | undefined => {
  if (name === "call_tool") return undefined
  const exposure = registry.chatKinds.get(kind)?.allowsOutside ? registry.operationTools.get(name) : undefined
  const common = exposure ? registry.operationTool(exposure) : registry.rolloutTools.get(name)
  const variant = registry.kindTools.get(`${kind}:${name}`)?.tool
  const tool = common?.kindOverrides?.includes(kind) ? variant : (variant ?? common)
  if (tool?.replyTool === false && registry.chatKinds.get(kind)?.allowsOutside !== true) return undefined
  if (tool?.storyRead === "conversation" && registry.chatKinds.get(kind)?.allowsOutside)
    return {
      ...tool,
      execute: (ctx, args) =>
        tool.execute(
          {
            ...ctx,
            storyReadOf: (id) => {
              const exposure = registry.operationTools.get(id)
              return (
                registry.kindTools.get(`${kind}:${id}`)?.tool.storyRead ??
                exposure?.storyRead ??
                registry.rolloutTools.get(id)?.storyRead
              )
            }
          },
          args
        )
    }
  if (!tool || registry.chatKinds.get(kind)?.allowsOutside || !tool.capability) return tool
  // Capability grants are workshop metadata. Preserve the frozen story definition shape.
  const storyTool = { ...tool }
  delete storyTool.capability
  return storyTool
}
