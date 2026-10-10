import { Context, Effect, Exit, FiberMap, Layer, PubSub, Schema, Stream } from "effect"
import type { ChatEvent, NotFound, Version } from "../shared/api.ts"
import { streamCompletion } from "./provider.ts"
import { Store } from "./store.ts"

class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  message: Schema.String
}) {}

/** Bridges the promise-based provider: the stream's scope owns an AbortController. */
const providerStream = (options: { tokens: number; tokensPerSecond: number; seed: number }) =>
  Stream.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      // Abort only when the stream didn't complete; a finished call has nothing to cancel.
      (controller, exit) => Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => controller.abort())
    ).pipe(
      Effect.map((controller) =>
        Stream.fromAsyncIterable(
          streamCompletion(options, controller.signal),
          (cause) => new ProviderError({ message: String(cause) })
        )
      )
    )
  )

/** Merges consecutive deltas for the same version, so a batch carries one delta per version. */
const coalesce = (events: ReadonlyArray<ChatEvent>): Array<ChatEvent> => {
  const out: Array<ChatEvent> = []
  for (const event of events) {
    const last = out[out.length - 1]
    if (event._tag === "Delta" && last?._tag === "Delta" && last.versionId === event.versionId) {
      out[out.length - 1] = { ...last, text: last.text + event.text }
    } else {
      out.push(event)
    }
  }
  return out
}

export class Generations extends Context.Service<Generations, {
  readonly generate: (slotId: string, tokensPerSecond: number, tokens: number) => Effect.Effect<Version, NotFound>
  readonly stop: (versionId: string) => Effect.Effect<boolean>
  readonly publish: (event: ChatEvent) => Effect.Effect<void>
  readonly subscribe: Stream.Stream<ReadonlyArray<ChatEvent>>
}>()("spike/Generations") {
  static readonly layer = Layer.effect(
    Generations,
    Effect.gen(function*() {
      const store = yield* Store
      // One chat in the spike; the real thing keys this per chat.
      const events = yield* PubSub.unbounded<ChatEvent>()
      const running = yield* FiberMap.make<string>()
      let seed = 0

      const publish = (event: ChatEvent) => PubSub.publish(events, event).pipe(Effect.asVoid)

      const run = (version: Version, tokensPerSecond: number, tokens: number) => {
        let text = ""
        return providerStream({ tokens, tokensPerSecond, seed: seed++ }).pipe(
          Stream.runForEach((token) => {
            text += token
            return publish({ _tag: "Delta", versionId: version.id, text: token })
          }),
          // onExit runs uninterruptibly, so a stopped generation still persists its partial text.
          Effect.onExit((exit) => {
            const status = Exit.isSuccess(exit) ? "complete" : Exit.hasInterrupts(exit) ? "stopped" : "failed"
            return store.finishVersion(version.id, text, status).pipe(
              Effect.andThen(publish({
                _tag: "StatusChanged",
                versionId: version.id,
                status,
                ...(status === "failed" ? { error: String(Exit.isFailure(exit) ? exit.cause : "") } : {})
              }))
            )
          })
        )
      }

      const generate = Effect.fn("Generations.generate")(function*(slotId: string, tokensPerSecond: number, tokens: number) {
        const version = yield* store.createVersion(slotId)
        yield* publish({ _tag: "VersionCreated", version })
        yield* FiberMap.run(running, version.id, run(version, tokensPerSecond, tokens))
        return version
      })

      const stop = (versionId: string) =>
        FiberMap.has(running, versionId).pipe(
          Effect.tap((has) => has ? FiberMap.remove(running, versionId) : Effect.void)
        )

      const subscribe = Stream.fromPubSub(events).pipe(
        Stream.groupedWithin(512, "16 millis"),
        Stream.map(coalesce)
      )

      return Generations.of({ generate, stop, publish, subscribe })
    })
  )
}
