import { assert, it } from "@effect/vitest"
import { inject } from "vitest"
import { Effect, Exit } from "effect"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
for (const workers of ["source", "bundle"] as const)
  it.live(`plugin storage and pins isolate accounts and plugins in ${workers} workers`, () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer,
        reader = yield* Database.Reader
      const a = yield* writer.EnsureUser({ handle: "owner", displayName: "Owner" }),
        b = yield* writer.EnsureUser({ handle: "other", displayName: "Other" })
      const target = { userId: a.id, owner: a.id, pluginId: "tiny", key: "x" }
      // Startup may suspend a disabled admin's pins, but never read that account's private data.
      yield* writer.SetPluginPins({ userId: a.id, owner: b.id, value: {}, revision: 0 })
      assert.strictEqual((yield* reader.GetPluginPins({ userId: a.id, owner: b.id })).revision, 1)
      assert.isTrue(Exit.isFailure(yield* Effect.exit(reader.GetPluginPins({ userId: b.id, owner: a.id }))))
      assert.isTrue(Exit.isFailure(yield* Effect.exit(reader.GetPluginData({ ...target, owner: b.id }))))
      yield* writer.SetPluginData({ ...target, value: { synthetic: true }, revision: 0 })
      assert.strictEqual((yield* reader.GetPluginData(target))?.revision, 1)
      assert.deepStrictEqual(yield* reader.PluginDataInfo(target), [{ key: "x", bytes: 18 }])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(reader.PluginDataInfo({ ...target, userId: b.id }))))
      assert.deepStrictEqual(yield* reader.PluginDataInfo({ ...target, pluginId: "other" }), [])
      assert.deepStrictEqual(yield* reader.ListPluginData({ ...target, pluginId: "other" }), [])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(reader.GetPluginData({ ...target, userId: b.id }))))
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(writer.SetPluginData({ ...target, userId: b.id, value: "evil", revision: 1 }))
        )
      )
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(writer.DeletePluginData({ ...target, userId: b.id, revision: 1 })))
      )
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(writer.SetPluginData({ ...target, value: "stale", revision: 0 })))
      )
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(writer.SetPluginData({ ...target, owner: "", userId: b.id, value: "evil", revision: 0 }))
        )
      )
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(writer.SetPluginPins({ userId: b.id, owner: "", value: {}, revision: 0 })))
      )
      // An individual value limit must also bound a namespace's aggregate storage.
      for (let index = 0; index < 16; index++)
        yield* writer.SetPluginData({ ...target, key: `quota-${index}`, value: "x".repeat(524280), revision: 0 })
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            writer.SetPluginData({ ...target, key: "overflow", value: "x".repeat(524280), revision: 0 })
          )
        )
      )
      yield* writer.SetPluginData({ ...target, key: "quota-0", value: "small", revision: 1 })
      yield* writer.SetPluginData({ ...target, key: "overflow", value: "x".repeat(524280), revision: 0 })
      yield* writer.SetPluginData({ ...target, owner: "", value: "instance", revision: 0 })
      assert.strictEqual((yield* reader.GetPluginData({ ...target, owner: "" }))?.value, "instance")
      yield* writer.DeletePluginData({ ...target, revision: 1 })
      assert.isNull(yield* reader.GetPluginData(target))
    }).pipe(
      Effect.provide(
        Database.layer({
          dataDir: tempDir("plugin-storage"),
          readers: 1,
          allowNetworkFs: false,
          workers,
          bundleDir: inject("bundleDir")
        })
      )
    )
  )
