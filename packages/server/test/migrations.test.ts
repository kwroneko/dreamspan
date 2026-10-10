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

const { "0005_providers": _providers, ...beforeProviders } = migrations

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
