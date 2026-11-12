// The current baseline schema, fresh defaults and refusal of incompatible migration ledgers.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { Migrations, migrations } from "../src/db/migrations.ts"
import { tempDir } from "./support/tempDir.ts"

interface Entry {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string
}

/** Recorded current sqlite_master, including deliberate baseline edits; no seed rows. */
const chain = (
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/preSquashSchema.json"), "utf8")) as {
    schema: ReadonlyArray<Entry>
  }
).schema

const layer = () => writerConnection(join(tempDir("mig"), "db.sqlite"))

describe("0001_baseline", () => {
  it.effect("bumps existing connections for provider setting writes, never for reads or unchanged values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.scoped(Layer.build(Migrations))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* sql`INSERT INTO connections (id, owner_user_id, name, provider, kind, api, created_at, updated_at)
        VALUES ('c', 'u', 'Synthetic', 'anthropic-bedrock', 'anthropic-bedrock', 'anthropic-messages', 0, 0)`
      const revision = () =>
        sql<{ cache_revision: number }>`SELECT cache_revision FROM connections WHERE id = 'c'`.pipe(
          Effect.map(([row]) => row!.cache_revision)
        )
      const start = yield* revision()
      // Each provider setting can change the transport or the reusable prefix.
      for (const [index, changes] of [
        { auth: "aws-sigv4" },
        { region: "eu-west-3" },
        { cacheBreakpoints: "explicit" },
        { lookback: true },
        { maxMarkers: 3 },
        { minTokens: 1024 },
        { promptCacheKey: true }
      ].entries()) {
        const encoded = JSON.stringify(changes)
        yield* sql`UPDATE connections SET provider_settings_json = ${encoded} WHERE id = 'c'`
        assert.strictEqual(yield* revision(), start + index + 1)
        yield* sql`UPDATE connections SET provider_settings_json = ${encoded} WHERE id = 'c'`
        yield* sql`SELECT * FROM connections WHERE id = 'c'`
        assert.strictEqual(yield* revision(), start + index + 1)
      }
      yield* sql`UPDATE connections SET name = 'Renamed', row_version = row_version + 1 WHERE id = 'c'`
      assert.strictEqual(yield* revision(), start + 7)
    }).pipe(Effect.provide(layer()))
  )
  it.effect("matches the recorded baseline schema and seeds nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_baseline": migrations["0001_baseline"] }) })
      const master = yield* sql<Entry>`SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations'`
      const made = master
        .map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql: sql.replace(/\s+/g, " ") }))
        .sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name))
      assert.deepStrictEqual(made, chain)

      const tables = master.filter(
        (entry) => entry.type === "table" && !/_(data|idx|docsize|config|content)$/.test(entry.name)
      )
      for (const table of tables) {
        const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(table.name)}`
        assert.strictEqual(row!.n, 0, table.name)
      }
    }).pipe(Effect.provide(layer()))
  )
})

describe("the migrator", () => {
  it.effect("refuses a database whose ledger holds ids this code doesn't know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'users'), (56, 'card_forks')`
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(Migrations)))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "empty data directory")
      const tables = yield* sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'users'`
      assert.strictEqual(tables[0]!.n, 0)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("runs on a database that already holds the baseline", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(Migrations))
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(Migrations)))
      assert.isTrue(Exit.isSuccess(exit))
    }).pipe(Effect.provide(layer()))
  )
})

it.effect("fresh defaults include composer guidance, branch additions and global chat pins", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.scoped(Layer.build(Migrations))
    yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'rp', 'active', 0)`
    yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, content, updated_at)
      VALUES ('d', 'u', 'composer', 'c', 'Synthetic draft', 0)`
    assert.deepStrictEqual(
      (yield* sql`SELECT guidance FROM drafts`).map((r) => r.guidance),
      [0]
    )
    yield* sql`INSERT INTO chat_pins (user_id, chat_id) VALUES ('u', 'c')`
    assert.deepStrictEqual(
      (yield* sql`PRAGMA table_info(chat_pins)`).map((r) => r.name),
      ["user_id", "chat_id"]
    )
    assert.isTrue(
      (yield* sql`PRAGMA table_info(fork_summaries)`).some((r) => r.name === "added_json" && r.dflt_value === "'[]'")
    )
    assert.deepStrictEqual(Object.keys(migrations), ["0001_baseline"])
  }).pipe(Effect.provide(layer()))
)
