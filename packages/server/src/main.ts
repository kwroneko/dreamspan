import { NodeRuntime } from "@effect/platform-node"
import { Cause, Exit, Layer, Runtime } from "effect"
import { AppConfig } from "./config.ts"
import { ServerLive } from "./server.ts"

/**
 * SIGTERM or SIGINT interrupts the server, and that's how it's meant to stop: exit 0, not
 * the default 130, which systemd counts as a failure. Anything else keeps the default.
 */
const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit)

ServerLive.pipe(Layer.provide(AppConfig.layer), Layer.launch, NodeRuntime.runMain({ teardown }))
