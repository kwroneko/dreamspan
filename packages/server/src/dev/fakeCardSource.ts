// The fake card archive as the card sources' "cardex" (spec/CARD-SOURCES.md §10), for the
// development server, previews and browser tests: a local server of synthetic cards in place
// of the real adapter, which doesn't exist yet, so no real archive is ever contacted.
import { Effect, Layer } from "effect"
import { fakeArchiveAdapter, startFakeArchive } from "../../test/support/fakeArchive.ts"
import * as CardSources from "../sources/CardSources.ts"

/**
 * The card sources for a `FAKE_CARD_SOURCE` setting: `off` (or unset, where `orNone`), none;
 * `0`, the fake archive on a free port; a number, on that port (browser tests read its counts there).
 */
export const fakeCardSources = (setting: string | undefined) =>
  setting === undefined || setting === "off"
    ? CardSources.layer
    : Layer.unwrap(
        Effect.gen(function* () {
          const archive = yield* Effect.acquireRelease(
            Effect.promise(() => startFakeArchive({ port: Number(setting) || 0 })),
            (started) => Effect.promise(() => started.close())
          )
          yield* Effect.logWarning(`fake card source active: synthetic "cardex" cards from ${archive.origin}`)
          return CardSources.layerWith({ adapters: [fakeArchiveAdapter({ origin: archive.origin })] })
        })
      )
