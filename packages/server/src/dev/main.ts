// The development server: main.ts, plus the fake generator when FAKE_GENERATOR_TPS is set.
// For `npm run dev:server`, the browser tests and the performance harness. The production
// entry point (main.ts) can't wire the fake generator, and the image doesn't contain this
// directory (.dockerignore).
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Config, Effect, Exit, Layer, Option, Runtime, Schema } from "effect"
import { Generator } from "../chat/Generator.ts"
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
  /** Tokens a second for each generation; unset, nothing generates, as in production. */
  tokensPerSecond: Config.option(Config.Number("FAKE_GENERATOR_TPS")),
  /** About how many tokens each generation has. */
  tokens: Config.Int("FAKE_GENERATOR_TOKENS").pipe(Config.withDefault(400))
})

Effect.gen(function* () {
  if (process.env.NODE_ENV === "production") return yield* new FakeGeneratorInProduction()
  const { tokensPerSecond, tokens } = yield* options
  const generator = Option.match(tokensPerSecond, {
    onNone: () => Generator.none,
    onSome: (rate) => FakeGenerator.layer({ tokensPerSecond: rate, tokens })
  })
  return yield* Layer.launch(serverWith(generator).pipe(Layer.provide(AppConfig.layer)))
}).pipe(NodeRuntime.runMain({ teardown }))
