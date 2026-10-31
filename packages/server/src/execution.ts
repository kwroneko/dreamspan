import { defaultReplyStrategy, type ReplyStrategy } from "./chat/replyStrategy.ts"
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
  }
>()("rp/ExecutionRegistry") {
  static readonly layer = Layer.effect(
    ExecutionRegistry,
    Effect.gen(function* () {
      const replyStrategies = makeRegistry<ReplyStrategy>()
      yield* replyStrategies.register(defaultReplyStrategy)
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
      return { replyStrategies, replies, replyParsers, liveRewrites, summaries, summaryTools }
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
