import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import * as ContextGenerator from "./chat/ContextGenerator.ts"
import { AppConfig } from "./config.ts"
import { ServerLive, serverWith } from "./server.ts"
import { serverEnvironment } from "./serverEnvironment.ts"

/**
 * SIGTERM or SIGINT interrupts the server, and that's how it's meant to stop: exit 0, not
 * the default 130, which systemd counts as a failure. Anything else keeps the default.
 */
const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit)

/**
 * A development instance (not production) may ask for the fake card archive in place of a real
 * card source (`FAKE_CARD_SOURCE`, as the development server reads it), so its content stays
 * synthetic. Production registers no card source.
 */
const fakeCardSource = process.env[serverEnvironment.FAKE_CARD_SOURCE]
const server =
  fakeCardSource === undefined || fakeCardSource === "off" || process.env[serverEnvironment.NODE_ENV] === "production"
    ? ServerLive
    : Layer.unwrap(
        Effect.map(
          Effect.promise(() => import("./dev/fakeCardSource.ts")),
          ({ fakeCardSources }) =>
            serverWith(ContextGenerator.layer, undefined, undefined, undefined, fakeCardSources(fakeCardSource))
        )
      )

server.pipe(Layer.provide(AppConfig.layer), Layer.launch, NodeRuntime.runMain({ teardown }))
