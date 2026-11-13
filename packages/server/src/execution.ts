import { historyRenameTool, historySearchTool, rewriteTools } from "./agent/tools/rewrite.ts"
import { makeOperationTools, type OperationRuntime } from "./agent/operations.ts"
import { builtinOperationExposures } from "./agent/exposures/builtins.ts"
import { rolloutEffectClasses } from "./agent/effects.ts"
import { outsideEffect } from "./agent/effects.ts"
import { capabilityDefaults, workshopCapabilities } from "./agent/capabilities.ts"
import { libraryEditCard, setupTools } from "./agent/tools/setup.ts"
import { chatKinds, type ChatKindProfile } from "@rp/shared/chatKinds.ts"
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
import { defaultMode, type OrchestrationMode } from "./agent/modes.ts"
import type { RolloutTool } from "./agent/tools.ts"
import { Context, Effect, Layer, Option } from "effect"
import { makeRegistry, type Registry } from "./registry.ts"
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
      for (const entry of builtinOperationExposures) yield* operationTools.register(entry)
      yield* orchestrationModes.register({
        ...workshopMode,
        plan: (input) => {
          const plan = workshopMode.plan(input)
          return {
            ...plan,
            tools: [
              ...new Set([...plan.tools, ...rewriteTools.map((e) => e.id), ...operationTools.list().map((e) => e.id)])
            ]
          }
        }
      })
      const validate = (tool: RolloutTool<never>) => {
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
        { ...editCard, kindOverrides: ["workshop"] }
      ] as ReadonlyArray<RolloutTool<never>>)
        yield* rolloutTools.register(tool)
      const replies = makeRegistry<ReplyOutputStrategy>()
      const summaries = makeRegistry<SummaryStrategy>()
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
        operationRuntime
      }
    })
  )
}

/** Standalone service construction uses the same scoped defaults as the server. */
export const executionRegistry = Effect.gen(function* () {
  const current = yield* Effect.serviceOption(ExecutionRegistry)
  if (Option.isSome(current)) return current.value
  const context = yield* Layer.build(ExecutionRegistry.layer)
  return Context.get(context, ExecutionRegistry)
})

/** A kind may replace an ambiguous public tool name without changing story semantics. */
export const toolForKind = (registry: ExecutionRegistry["Service"], kind: string, name: string) => {
  const exposure = registry.chatKinds.get(kind)?.allowsOutside ? registry.operationTools.get(name) : undefined
  const common = exposure ? registry.operationTool(exposure) : registry.rolloutTools.get(name)
  const variant = registry.kindTools.get(`${kind}:${name}`)?.tool
  const tool = common?.kindOverrides?.includes(kind) ? variant : (variant ?? common)
  if (tool?.replyTool === false && registry.chatKinds.get(kind)?.allowsOutside !== true) return undefined
  if (!tool || registry.chatKinds.get(kind)?.allowsOutside || !tool.capability) return tool
  // Capability grants are workshop metadata. Preserve the frozen story definition shape.
  const storyTool = { ...tool }
  delete storyTool.capability
  return storyTool
}
