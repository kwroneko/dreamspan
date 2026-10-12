// Media an import has written and not yet recorded (ARCHITECTURE.md §11.1), by hash with
// a count of imports, so the sweep leaves them alone until the import commits or gives up.
// One for the server, shared by library uploads and the ST folder import.
import { Context, Effect, Layer } from "effect"

export class MediaHolds extends Context.Service<
  MediaHolds,
  {
    readonly pending: ReadonlyMap<string, number>
    /** Runs `effect` with these files held. */
    readonly holding: <A, E, R>(hashes: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("rp/importer/MediaHolds") {
  static readonly layer = Layer.sync(MediaHolds, () => {
    const pending = new Map<string, number>()
    return {
      pending,
      holding: (hashes, effect) =>
        Effect.acquireUseRelease(
          Effect.sync(() => hashes.forEach((sha256) => pending.set(sha256, (pending.get(sha256) ?? 0) + 1))),
          () => effect,
          () =>
            Effect.sync(() =>
              hashes.forEach((sha256) => {
                const count = (pending.get(sha256) ?? 1) - 1
                if (count === 0) pending.delete(sha256)
                else pending.set(sha256, count)
              })
            )
        )
    }
  })
}
