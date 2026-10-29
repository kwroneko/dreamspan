import { assert, it } from "@effect/vitest"
import { BinLimits, defaultBinLimits } from "@rp/shared/bin.ts"
import { Effect, Schema } from "effect"
import * as Database from "../src/db/Database.ts"
import { client, testConfig, withServer } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"

it.live("persists independent capacities across worker restart, with no purge when a limit is saved", () => {
  const dataDir = tempDir("bin-limits")
  const database = Database.layer({ dataDir, readers: 1, workers: "source", allowNetworkFs: false })
  const first = Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle: "limits", displayName: "Limits" })
    assert.deepStrictEqual(yield* reader.GetBinLimits({ userId: user.id }), defaultBinLimits)
    for (let n = 0; n < 3; n++) {
      const chat = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: `Deleted ${n}`,
        participants: [],
        greeting: null
      })
      yield* writer.DeleteChat({ userId: user.id, chatId: chat.id })
    }
    const changed = yield* writer.ChangeBinLimit({ userId: user.id, key: "deletedItems", value: 2 })
    assert.deepStrictEqual(changed, { ...defaultBinLimits, deletedItems: 2 })
    assert.lengthOf(yield* reader.ListBin({ userId: user.id, limit: 10, before: null }), 3)
    yield* writer.ChangeBinLimit({ userId: user.id, key: "recoveredBytes", value: 25 })
    return user.id
  }).pipe(Effect.provide(database), Effect.scoped)
  return Effect.gen(function* () {
    const userId = yield* first
    yield* Effect.gen(function* () {
      const reader = yield* Database.Reader
      const writer = yield* Database.Writer
      assert.deepStrictEqual(yield* reader.GetBinLimits({ userId }), {
        ...defaultBinLimits,
        deletedItems: 2,
        recoveredBytes: 25
      })
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Latest",
        participants: [],
        greeting: null
      })
      yield* writer.DeleteChat({ userId, chatId: chat.id })
      assert.lengthOf(yield* reader.ListBin({ userId, limit: 10, before: null }), 2)
      // An item larger than the whole section must not empty the bin.
      yield* writer.ChangeBinLimit({ userId, key: "deletedBytes", value: 1 })
      const large = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Oversized".repeat(20),
        participants: [],
        greeting: null
      })
      yield* writer.DeleteChat({ userId, chatId: large.id })
      assert.lengthOf(yield* reader.ListBin({ userId, limit: 10, before: null }), 3)
    }).pipe(Effect.provide(database), Effect.scoped)
  })
})

it.live("bin limits are available through authenticated RPC and reject unsafe capacities", () =>
  Effect.gen(function* () {
    const api = yield* client()
    assert.deepStrictEqual(yield* api.GetBinLimits(), defaultBinLimits)
    for (const key of ["deletedItems", "deletedBytes", "recoveredTexts", "recoveredBytes"] as const) {
      const value = key.endsWith("Bytes") ? 1024 : 3
      yield* api.ChangeBinLimit({ key, value })
      assert.strictEqual((yield* api.GetBinLimits())[key], value)
    }
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.isFalse(Schema.is(BinLimits)({ ...defaultBinLimits, deletedItems: value }))
    }
  }).pipe(Effect.scoped, withServer(testConfig()))
)
