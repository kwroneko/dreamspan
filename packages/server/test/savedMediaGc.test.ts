import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { cardDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

it.effect("keeps a saved file while a new revision still needs scanning", () =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle: "alice", displayName: "Alice" })
    const create = () =>
      writer.CreateEntity({
        userId: user.id,
        kind: "card",
        label: "Map",
        subtitle: "",
        doc: cardDoc("Map", { first_mes: '<img src="https://cards.test/pixel.png">' }),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const scan = Effect.gen(function* () {
      const scans = yield* reader.ReadSavedMediaScans({ userId: user.id, refIds: null, limit: 100 })
      yield* writer.RecordSavedMediaScans({ scans, at: 1 })
    })
    yield* writer.ChangeMediaHosts({ userId: user.id, add: { host: "cards.test", subdomains: false }, at: 1 })
    const first = yield* create()
    yield* scan
    const [pending] = yield* reader.NextSavedMediaDownloads({ skip: [], limit: 100 })
    const result = {
      id: pending!.id,
      ownerUserId: pending!.ownerUserId,
      url: pending!.url,
      at: 2,
      saved: { sha256: "1".repeat(64), mime: "image/png", byteSize: 100 },
      failure: null
    }
    assert.isFalse(yield* writer.RecordSavedMediaResult({ ...result, url: `${result.url}?other` }))
    assert.isTrue(yield* writer.RecordSavedMediaResult(result))
    const [before] = yield* reader.LookupSavedMedia({ userId: user.id, urls: ["https://cards.test/pixel.png"] })
    const second = yield* create() // deliberately not scanned: no background task in this test
    const deleted = yield* writer.DeleteEntity({ userId: user.id, entityId: first.entityId })
    yield* writer.PurgeBinItem({ userId: user.id, itemId: deleted.id })
    assert.strictEqual(yield* writer.PruneSavedMedia(), 0)
    yield* scan
    assert.deepStrictEqual(
      yield* reader.LookupSavedMedia({ userId: user.id, urls: ["https://cards.test/pixel.png"] }),
      [before!]
    )
    assert.isNotNull(yield* reader.GetSavedMediaFile({ userId: user.id, mediaId: before!.mediaId! }))
    const last = yield* writer.DeleteEntity({ userId: user.id, entityId: second.entityId })
    yield* writer.PurgeBinItem({ userId: user.id, itemId: last.id })
    assert.strictEqual(yield* writer.PruneSavedMedia(), 1)
    assert.isNull(yield* reader.GetSavedMediaFile({ userId: user.id, mediaId: before!.mediaId! }))
  }).pipe(
    Effect.provide(Database.layer({ dataDir: tempDir("saved-gc"), readers: 1, allowNetworkFs: false, ...testWorkers }))
  )
)
