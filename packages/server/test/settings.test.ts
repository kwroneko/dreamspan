import { assert, describe, it } from "@effect/vitest"
import { inject } from "vitest"
import { Effect, Exit, Schema, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { Migrations } from "../src/db/migrations.ts"
import { Layer } from "effect"
import { deviceScopeId, readSetting, settingsRegistry, writeSetting } from "../src/db/settings.ts"
import { transaction } from "../src/db/tx.ts"
import * as Database from "../src/db/Database.ts"
import { StateModules } from "../src/db/stateModules.ts"
import { tempDir } from "./support/tempDir.ts"

it.effect(
  "settings validate scope/schema, replace registrations, isolate owners and reject stale revisions atomically",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.scoped(Layer.build(Migrations))
      yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES ('a','a','A','user',0), ('b','b','B','user',0)`
      const put = (scope: "app" | "user" | "device", id: string, key: string, value: unknown, revision?: number) =>
        writeSetting(sql, scope, id, key, value, revision).pipe(transaction(sql, "testSetting"))
      for (const [scope, id, key, value] of [
        ["user", "a", "unknown", true],
        ["app", "", "shell.pinsCollapsed", true],
        ["user", "a", "shell.pinsCollapsed", "yes"],
        ["user", "missing", "shell.pinsCollapsed", true]
      ] as const) {
        const error = yield* Effect.flip(put(scope, id, key, value))
        assert.strictEqual(error._tag, "StorageError")
      }
      assert.strictEqual(yield* put("user", "a", "shell.pinsCollapsed", true, 0), 1)
      assert.deepStrictEqual(yield* readSetting(sql, "user", "b", "shell.pinsCollapsed"), { value: null, revision: 0 })
      assert.strictEqual(yield* put("user", "a", "shell.pinsCollapsed", false, 1), 2)
      const stale = yield* Effect.flip(put("user", "a", "shell.pinsCollapsed", true, 1))
      assert.strictEqual(stale._tag, "StaleWrite")
      if (stale._tag === "StaleWrite") assert.strictEqual(stale.actual, 2)
      assert.deepStrictEqual(yield* readSetting(sql, "user", "a", "shell.pinsCollapsed"), { value: false, revision: 2 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* settingsRegistry.register({ id: "synthetic/device", scope: "device", schema: Schema.Int })
          yield* put("device", deviceScopeId("a", "desktop"), "synthetic/device", 1)
          assert.deepStrictEqual(yield* readSetting(sql, "device", deviceScopeId("b", "desktop"), "synthetic/device"), {
            value: null,
            revision: 0
          })
          assert.deepStrictEqual(yield* readSetting(sql, "device", deviceScopeId("a", "phone"), "synthetic/device"), {
            value: null,
            revision: 0
          })
        })
      )
      // Reset preserves the revision; an old pre-reset snapshot can never become current again.
      yield* put("user", "a", "generation.preset", "synthetic", 0)
      yield* put("user", "a", "generation.preset", null, 1)
      assert.strictEqual((yield* Effect.flip(put("user", "a", "generation.preset", "old", 0)))._tag, "StaleWrite")
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* settingsRegistry.register({ id: "synthetic/value", scope: "user", schema: Schema.Int })
          yield* put("user", "a", "synthetic/value", 1)
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* settingsRegistry.register({ id: "synthetic/value", scope: "user", schema: Schema.String })
              assert.strictEqual((yield* Effect.flip(put("user", "a", "synthetic/value", 2)))._tag, "StorageError")
              yield* put("user", "a", "synthetic/value", "replacement")
            })
          )
          yield* put("user", "a", "synthetic/value", 3)
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* settingsRegistry.disable("synthetic/value")
              assert.strictEqual((yield* Effect.flip(put("user", "a", "synthetic/value", 4)))._tag, "StorageError")
            })
          )
        })
      )
      const rollback = Effect.gen(function* () {
        yield* writeSetting(sql, "user", "a", "shell.pinsCollapsed", true)
        yield* writeSetting(sql, "user", "a", "synthetic/value", 4)
      }).pipe(transaction(sql, "testRollback"))
      assert.strictEqual((yield* Effect.flip(rollback))._tag, "StorageError")
      assert.deepStrictEqual(yield* readSetting(sql, "user", "a", "shell.pinsCollapsed"), { value: false, revision: 2 })
      const [row] = yield* sql<{
        updated_at: number
      }>`SELECT updated_at FROM settings WHERE scope='user' AND scope_id='a' AND key='shell.pinsCollapsed'`
      assert.isAbove(row!.updated_at, 0)
      const tables = yield* sql<{
        name: string
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('settings','user_prefs','user_settings','app_settings','shell_preferences','cost_settings')`
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        ["settings"]
      )
    }).pipe(Effect.provide(writerConnection(":memory:")), Effect.scoped)
)

for (const workers of ["source", "bundle"] as const) {
  describe(`settings in ${workers} workers`, () => {
    it.live(
      "loads plugin schemas in workers, validates replacements, and restores scope on exit",
      () =>
        Effect.gen(function* () {
          const writer = yield* Database.Writer
          const reader = yield* Database.Reader
          const modules = yield* StateModules
          const set = (value: unknown) => writer.SetAppSetting({ key: "synthetic/setting", value })
          assert.strictEqual((yield* Effect.flip(set(1)))._tag, "StorageError")
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))
          yield* Scope.provide(
            modules.register({
              id: "synthetic-settings",
              module: new URL("./support/settingsPlugin.ts", import.meta.url).href,
              exportName: "install"
            }),
            scope
          )
          yield* set(1)
          assert.strictEqual(yield* reader.GetAppSetting({ key: "synthetic/setting" }), 1)
          assert.strictEqual((yield* Effect.flip(set(-1)))._tag, "StorageError")
          assert.strictEqual(yield* reader.GetAppSetting({ key: "synthetic/setting" }), 1)
          yield* Scope.close(scope, Exit.void)
          assert.strictEqual((yield* Effect.flip(set(2)))._tag, "StorageError")
          assert.strictEqual(yield* reader.GetAppSetting({ key: "synthetic/setting" }), 1)
        }).pipe(
          Effect.provide(
            Database.layer({
              dataDir: tempDir("settings"),
              readers: 1,
              allowNetworkFs: false,
              workers,
              bundleDir: inject("bundleDir")
            })
          ),
          Effect.scoped
        ),
      120_000
    )
  })
}
