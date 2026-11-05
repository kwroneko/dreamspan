import { defaultReplyStrategy, type ReplyStrategy } from "./chat/replyStrategy.ts"
import { agentReplyStrategy } from "./agent/strategy.ts"
import { historyTools } from "./agent/tools/history.ts"
import { editCard } from "./agent/tools/cardEdit.ts"
import { editNote, listNotes, switchNote, writeNote } from "./agent/tools/notes.ts"
import { lookupLore } from "./agent/tools/lore.ts"
import { setPresence } from "./agent/tools/presence.ts"
import { cardSwapMode, narratorMode, plainMode, type OrchestrationMode } from "./agent/modes.ts"
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
    readonly orchestrationModes: Registry<OrchestrationMode>
    /** The tools an agent turn may offer, with their effect classes (spec/AGENTIC.md §4). */
    readonly rolloutTools: Registry<RolloutTool<never>>
  }
>()("rp/ExecutionRegistry") {
  static readonly layer = Layer.effect(
    ExecutionRegistry,
    Effect.gen(function* () {
      const replyStrategies = makeRegistry<ReplyStrategy>()
      yield* replyStrategies.register(defaultReplyStrategy)
      yield* replyStrategies.register(agentReplyStrategy)
      const orchestrationModes = makeRegistry<OrchestrationMode>()
      yield* orchestrationModes.register(plainMode)
      yield* orchestrationModes.register(narratorMode)
      yield* orchestrationModes.register(cardSwapMode)
      const rolloutTools = makeRegistry<RolloutTool<never>>()
      for (const tool of [...historyTools, lookupLore, listNotes, writeNote, editNote, switchNote, setPresence, editCard] as ReadonlyArray<RolloutTool<never>>)
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
        rolloutTools
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
