import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import { AppConfig, FakeGeneratorInProduction } from "./config.ts"
import { ServerLive } from "./server.ts"

/**
 * SIGTERM or SIGINT interrupts the server, and that's how it's meant to stop: exit 0, not
 * the default 130, which systemd counts as a failure. Anything else keeps the default.
 */
const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit)

/** The fake generator writes made-up text into chats, so production never runs with it. */
const refuseFakeGenerator = Effect.suspend(() =>
  process.env.NODE_ENV === "production" && process.env.FAKE_GENERATOR_TPS !== undefined
    ? Effect.fail(new FakeGeneratorInProduction())
    : Effect.void
)

refuseFakeGenerator.pipe(
  Effect.andThen(Layer.launch(ServerLive.pipe(Layer.provide(AppConfig.layer)))),
  NodeRuntime.runMain({ teardown })
)
