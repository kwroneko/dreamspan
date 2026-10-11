// Migrations through the real migrator and writer connection settings.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"

/** The migrations that run before `name`. The migrator skips anything older than the latest it has run. */
const before = (name: string) => Object.fromEntries(Object.entries(migrations).filter(([key]) => key < name))
const beforeProviders = before("0005_providers")

describe("0005_providers", () => {
  it.effect("refuses to recreate connections that already hold rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(beforeProviders) })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
      yield* sql`INSERT INTO connections (id, owner_user_id, name, api, created_at, updated_at)
        VALUES ('c', 'u', 'Kept', 'openai-completions', 1, 1)`

      const exit = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      const kept = yield* sql<{ name: string }>`SELECT name FROM connections`
      assert.deepStrictEqual(kept, [{ name: "Kept" }])
    }).pipe(Effect.provide(writerConnection(join(mkdtempSync(join(tmpdir(), "rp-mig-")), "db.sqlite"))))
  )
})

describe("0006_credentials", () => {
  const beforeCredentials = before("0006_credentials")

  it.effect("refuses to retire per-connection keys while a connection holds one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(beforeCredentials) })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
      yield* sql`INSERT INTO connections (id, owner_user_id, name, kind, api, api_key_enc, key_hint, created_at, updated_at)
        VALUES ('c', 'u', 'Keyed', 'openai-chat', 'openai-completions', x'00', 'abcd', 1, 1)`

      const exit = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      const kept = yield* sql<{ key_hint: string }>`SELECT key_hint FROM connections`
      assert.deepStrictEqual(kept, [{ key_hint: "abcd" }])
    }).pipe(Effect.provide(writerConnection(join(mkdtempSync(join(tmpdir(), "rp-mig-")), "db.sqlite"))))
  )
})
