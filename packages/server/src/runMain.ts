import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import * as ContextGenerator from "./chat/ContextGenerator.ts"
import { AppConfig } from "./config.ts"
import { serverWith } from "./server.ts"
import { serverEnvironment } from "./serverEnvironment.ts"
import * as CardSources from "./sources/CardSources.ts"
import { cardexAdapter, cardSourceSetup } from "./sources/cardex.ts"

/**
 * SIGTERM or SIGINT interrupts the server, and that's how it's meant to stop: exit 0, not
 * the default 130, which systemd counts as a failure. Anything else keeps the default.
 */
const teardown: Runtime.Teardown = (exit, onExit) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? onExit(0) : Runtime.defaultTeardown(exit, onExit)

/**
 * The development instance and previews ask for the fake card archive in place of cardex by
 * setting `FAKE_CARD_SOURCE` (as the development server reads it), so their content stays
 * synthetic. Only that variable decides, since the development instance runs a production
 * build: production's units never set it and get the real cardex adapter; `off` registers none.
 */
const fakeCardSource = process.env[serverEnvironment.FAKE_CARD_SOURCE]
const setup = cardSourceSetup(fakeCardSource)
const server =
  setup === "fake"
    ? Layer.unwrap(
        Effect.map(
          Effect.promise(() => import("./dev/fakeCardSource.ts")),
          ({ fakeCardSources }) =>
            serverWith(ContextGenerator.layer, undefined, undefined, undefined, fakeCardSources(fakeCardSource))
        )
      )
    : serverWith(
        ContextGenerator.layer,
        undefined,
        undefined,
        undefined,
        setup === "cardex" ? CardSources.layerWith({ adapters: [cardexAdapter()] }) : CardSources.layer
      )

server.pipe(Layer.provide(AppConfig.layer), Layer.launch, NodeRuntime.runMain({ teardown }))
