// The development server: main.ts, or the fake generator instead of the real one when
// FAKE_GENERATOR_TPS is set.
// For `npm run dev:server`, the browser tests and the performance harness. The production
// entry point (main.ts) can't wire the fake generator, and the image doesn't contain this
// directory (.dockerignore).
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Config, Effect, Exit, Layer, Option, Runtime, Schema } from "effect"
import * as ContextGenerator from "../chat/ContextGenerator.ts"
import { AppConfig } from "../config.ts"
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
  tokensPerSecond: Config.option(Config.Number("FAKE_GENERATOR_TPS")),
  /** About how many tokens each generation has. */
  tokens: Config.Int("FAKE_GENERATOR_TOKENS").pipe(Config.withDefault(400)),
  /** Set, tokens come in bursts this many milliseconds apart (the performance harness). */
  burstMs: Config.option(Config.Int("FAKE_GENERATOR_BURST_MS"))
})

Effect.gen(function* () {
  if (process.env.NODE_ENV === "production") return yield* new FakeGeneratorInProduction()
  const { tokensPerSecond, tokens, burstMs } = yield* options
  const server = Option.match(tokensPerSecond, {
    onNone: () => serverWith(ContextGenerator.layer),
    onSome: (rate) =>
      serverWith(FakeGenerator.layer({ tokensPerSecond: rate, tokens, burstMs: Option.getOrUndefined(burstMs) }))
  })
  return yield* Layer.launch(server.pipe(Layer.provide(AppConfig.layer)))
}).pipe(NodeRuntime.runMain({ teardown }))
