import { serverEnvironment } from "../serverEnvironment.ts"
// The development server: main.ts, or the fake generator instead of the real one when
// FAKE_GENERATOR_TPS is set, and every decision point's deadline DECISION_TIMEOUT_MS when set.
// For `npm run dev:server`, the browser tests and the performance harness. The production
// entry point (main.ts) can't wire the fake generator, and the image doesn't contain this
// directory (.dockerignore).
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Config, Effect, Exit, Layer, Option, Runtime, Schema } from "effect"
import * as ContextGenerator from "../chat/ContextGenerator.ts"
import { AppConfig } from "../config.ts"
import { DecisionEngine } from "../decision/engine.ts"
import { serverWith } from "../server.ts"
import * as FakeGenerator from "./fakeGenerator.ts"

class FakeGeneratorInProduction extends Schema.TaggedError<FakeGeneratorInProduction>()(
  "FakeGeneratorInProduction",
  {}
) {
  override get message() {
    return "The development server is not for production: it writes synthetic text into chats."
  }
}

const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit)

const options = Config.all({
  /** Tokens a second for each fake generation; unset, the real generator, as in production. */
  tokensPerSecond: Config.option(Config.Number(serverEnvironment.FAKE_GENERATOR_TPS)),
  /** About how many tokens each generation has. */
  tokens: Config.Int(serverEnvironment.FAKE_GENERATOR_TOKENS).pipe(Config.withDefault(400)),
  /** A repeatable reply body, independent of random version ids (browser fixtures). */
  seed: Config.option(Config.Int(serverEnvironment.FAKE_GENERATOR_SEED)),
  /** Set, tokens come in bursts this many milliseconds apart (the performance harness). */
  burstMs: Config.option(Config.Int(serverEnvironment.FAKE_GENERATOR_BURST_MS)),
  /** Set, each fake reply streams about this many tokens of reasoning first, as a reasoning model's. */
  reasoningTokens: Config.option(Config.Int(serverEnvironment.FAKE_GENERATOR_REASONING)),
  /** Set, each fake reply's text starts with a tagged section of about this many tokens (spec/REPLY-SECTIONS.md). */
  sectionTokens: Config.option(Config.Int(serverEnvironment.FAKE_GENERATOR_SECTION)),
  /** Set, each fake reply's body starts with a `<cot>` chain of thought of about this many tokens (regex scripts). */
  cotTokens: Config.option(Config.Int(serverEnvironment.FAKE_GENERATOR_COT)),
  /**
   * Set, every decision point waits this many milliseconds for its answer instead of its own
   * deadline: browser tests that hold a decision while they look at the page.
   */
  decisionTimeoutMs: Config.option(Config.Int(serverEnvironment.DECISION_TIMEOUT_MS))
})

Effect.gen(function* () {
  if (process.env[serverEnvironment.NODE_ENV] === "production") return yield* new FakeGeneratorInProduction()
  const { tokensPerSecond, tokens, seed, burstMs, reasoningTokens, sectionTokens, cotTokens, decisionTimeoutMs } =
    yield* options
  const decisions = Option.match(decisionTimeoutMs, {
    onNone: () => DecisionEngine.layer,
    onSome: (timeoutMs) => DecisionEngine.layerWith({ timeoutMs })
  })
  const server = Option.match(tokensPerSecond, {
    onNone: () => serverWith(ContextGenerator.layer, undefined, undefined, decisions),
    onSome: (rate) =>
      serverWith(
        FakeGenerator.layer({
          tokensPerSecond: rate,
          tokens,
          seed: Option.getOrUndefined(seed),
          burstMs: Option.getOrUndefined(burstMs),
          reasoningTokens: Option.getOrUndefined(reasoningTokens),
          sectionTokens: Option.getOrUndefined(sectionTokens),
          cotTokens: Option.getOrUndefined(cotTokens)
        }),
        undefined,
        undefined,
        decisions
      )
  })
  return yield* Layer.launch(server.pipe(Layer.provide(AppConfig.layer)))
}).pipe(NodeRuntime.runMain({ teardown }))
