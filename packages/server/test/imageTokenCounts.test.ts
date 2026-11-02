import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { UserId } from "@rp/shared/domain.ts"
import { ImageTokenCounts, type UncountedImages } from "../src/chat/ImageTokenCounts.ts"
import { Providers } from "../src/providers/Providers.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { AppConfig } from "../src/config.ts"
import { mediaPath } from "../src/db/media.ts"
import { storeMedia } from "../src/importer/mediaFiles.ts"
import { testConfig } from "./support/config.ts"
import { eventually } from "./support/generation.ts"

const hash = "a".repeat(64)
const pending = (connectionId: string, sha256 = hash): UncountedImages => ({
  connectionId,
  kind: "anthropic",
  modelKey: "synthetic",
  detail: "auto",
  images: [{ mediaId: sha256, sha256 }]
})
const user = "owner" as UserId

const fixture = (
  count: Providers["Service"]["countImageTokens"],
  // Every connection counts through its own provider unless a test says otherwise.
  choices: (connectionId: string) => string | null = (connectionId) => connectionId
) => {
  const config = testConfig()
  const stored = new Map<string, number>()
  const known = ["connection-a", "connection-b", "connection-c", "connection-d"]
  const layers = [
    Layer.succeed(AppConfig)(config),
    Layer.succeed(Providers)({ countImageTokens: count } as Providers["Service"]),
    Layer.succeed(Reader)({
      GetTokenCounting: () =>
        Effect.succeed(
          known.flatMap((connectionId) => {
            const via = choices(connectionId)
            return via ? [{ connectionId, via }] : []
          })
        ),
      GetImageTokenCount: ({ sha256 }: { sha256: string }) => Effect.sync(() => stored.get(sha256) ?? null),
      GetMediaFile: ({ mediaId }: { mediaId: string }) =>
        Effect.succeed({ path: mediaPath(mediaId), mime: "image/png" })
    } as unknown as Reader["Service"]),
    Layer.succeed(Writer)({
      RecordImageTokenCount: ({ sha256, tokens }: { sha256: string; tokens: number }) =>
        Effect.sync(() => {
          stored.set(sha256, tokens)
        })
    } as unknown as Writer["Service"])
  ] as const
  return { config, stored, layer: ImageTokenCounts.layer.pipe(Layer.provide([...layers])) }
}

it.live("serializes all chats, deduplicates across connections, and rechecks persisted counts", () => {
  let active = 0,
    maximum = 0,
    calls = 0,
    finished = 0
  const h = fixture(() =>
    Effect.gen(function* () {
      calls++
      maximum = Math.max(maximum, ++active)
      yield* Effect.sleep("30 millis")
      active--
      return 800
    })
  )
  return Effect.gen(function* () {
    yield* storeMedia(h.config.dataDir, hash, Buffer.from("synthetic"))
    const other = "b".repeat(64)
    yield* storeMedia(h.config.dataDir, other, Buffer.from("other synthetic"))
    const counts = yield* ImageTokenCounts
    yield* counts.request(user, pending("connection-a"), () => {
      finished++
    })
    yield* counts.request(user, pending("connection-b"), () => {
      finished++
    })
    yield* counts.request(user, pending("connection-c", other), () => {
      finished++
    })
    yield* eventually(() => h.stored.size === 2 && finished === 2)
    assert.strictEqual(maximum, 1)
    assert.strictEqual(calls, 2)
    // A stale preview after completion must not count the same content again.
    yield* counts.request(user, pending("connection-d"), () => {
      finished++
    })
    yield* eventually(() => finished === 3)
    assert.strictEqual(calls, 2)
  }).pipe(Effect.provide(h.layer), Effect.scoped)
})

it.effect("times out a stalled count and backs off instead of stranding the queue", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let calls = 0
    const h = fixture(() =>
      Effect.gen(function* () {
        calls++
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      })
    )
    yield* Effect.gen(function* () {
      yield* storeMedia(h.config.dataDir, hash, Buffer.from("synthetic"))
      const counts = yield* ImageTokenCounts
      yield* counts.request(user, pending("connection-a"), () => {})
      yield* Deferred.await(started)
      yield* TestClock.adjust("31 seconds")
      yield* counts.request(user, pending("connection-a"), () => {})
      yield* TestClock.adjust("1 second")
      assert.strictEqual(calls, 1)
      assert.strictEqual(h.stored.size, 0)
    }).pipe(Effect.provide(h.layer))
  }).pipe(Effect.scoped)
)

it.live("passes no counting connection when the user chose none, and the one they chose otherwise", () => {
  const asked: Array<string | null> = []
  const h = fixture(
    ({ via }) =>
      Effect.sync(() => {
        asked.push(via)
        return null
      }),
    (connectionId) => (connectionId === "connection-b" ? "connection-c" : null)
  )
  return Effect.gen(function* () {
    yield* storeMedia(h.config.dataDir, hash, Buffer.from("synthetic"))
    const counts = yield* ImageTokenCounts
    yield* counts.request(user, pending("connection-a"), () => {})
    yield* eventually(() => asked.length === 1)
    // A choice made later isn't held up by the rest the default's answer earned.
    yield* counts.request(user, pending("connection-b"), () => {})
    yield* eventually(() => asked.length === 2)
    assert.deepStrictEqual(asked, [null, "connection-c"])
  }).pipe(Effect.provide(h.layer), Effect.scoped)
})
