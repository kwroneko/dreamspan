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
      yield* writer.SetPluginData({ ...target, value: { synthetic: true }, revision: 0 })
      assert.strictEqual((yield* reader.GetPluginData(target))?.revision, 1)
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
