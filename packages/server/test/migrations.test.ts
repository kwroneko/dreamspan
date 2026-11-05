// The baseline against its frozen schema dump (the 56-step chain it replaced, plus the fork deletion triggers and `history_changes` of unit 5, the token-estimate ledger fields/index, the draft deletion watermark and the compact lore activation receipts and card-asset bin kind, edited in as the baseline allows), and the migrator's refusal of a database
// made before it.
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

/**
 * sqlite_master as the old chain left it on an empty database (tables, indexes, triggers,
 * views, whitespace collapsed), dumped before the squash. The chain's only rows were its
 * ledger, so there were no seed rows to compare.
 */
const chain = (
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/preSquashSchema.json"), "utf8")) as {
    schema: ReadonlyArray<Entry>
  }
).schema

const layer = () => writerConnection(join(tempDir("mig"), "db.sqlite"))

describe("0001_baseline", () => {
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

it.effect("migrates existing composer switches from each account and removes only that preference", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_baseline": migrations["0001_baseline"] }) })
    for (const id of ["on", "off", "unset"])
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES (${id}, ${id}, ${id}, 'user', 0)`
    for (const [id, guidance] of [
      ["on", true],
      ["off", false]
    ] as const)
      yield* sql`INSERT INTO user_prefs (user_id, key, value_json)
        VALUES (${id}, 'display', ${JSON.stringify({ guidance, reasoning: "collapsed" })})`
    for (const [id, owner, kind] of [
      ["a", "on", "composer"],
      ["b", "on", "composer"],
      ["c", "off", "composer"],
      ["d", "unset", "composer"],
      ["e", "on", "scratchpad"]
    ])
      yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, content, updated_at)
        VALUES (${id!}, ${owner!}, ${kind!}, ${id!}, 'Synthetic draft', 0)`
    yield* Effect.scoped(Layer.build(Migrations))
    const rows = yield* sql<{
      id: string
      guidance: number
      content: string
    }>`SELECT id, guidance, content FROM drafts ORDER BY id`
    assert.deepStrictEqual(
      rows.map((row) => [row.id, row.guidance]),
      [
        ["a", 1],
        ["b", 1],
        ["c", 0],
        ["d", 0],
        ["e", 0]
      ]
    )
    assert.isTrue(rows.every((row) => row.content === "Synthetic draft"))
    const prefs = yield* sql<{ value_json: string }>`SELECT value_json FROM user_prefs ORDER BY user_id`
    assert.deepStrictEqual(
      prefs.map((row) => JSON.parse(row.value_json)),
      [{ reasoning: "collapsed" }, { reasoning: "collapsed" }]
    )
    yield* Effect.scoped(Layer.build(Migrations))
    const [again] = yield* sql<{ guidance: number }>`SELECT guidance FROM drafts WHERE id = 'a'`
    assert.strictEqual(again!.guidance, 1)
  }).pipe(Effect.provide(layer()))
)

it.effect("migrates branch pins to one global chat pin and preserves local pins on rerun", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* SqliteMigrator.run({
      loader: SqliteMigrator.fromRecord({
        "0001_baseline": migrations["0001_baseline"],
        "0002_composer_guidance": migrations["0002_composer_guidance"],
        "0003_branch_added_characters": migrations["0003_branch_added_characters"]
      })
    })
    yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('owner', 'owner', 'Owner', 'user', 0)`
    for (const id of ["pinned", "ordinary", "legacy"])
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at)
        VALUES (${id}, 'owner', 'rp', 'active', 0)`
    for (const [id, chat, pin] of [
      ["a", "pinned", 100],
      ["b", "pinned", 200],
      ["c", "ordinary", null]
    ] as const)
      yield* sql`INSERT INTO forks (id, chat_id, created_at, pinned_at) VALUES (${id}, ${chat}, 0, ${pin})`
    yield* sql`INSERT INTO chat_pins (user_id, chat_id, fork_id) VALUES ('owner', 'legacy', 'old')`
    yield* Effect.scoped(Layer.build(Migrations))
    const pins = yield* sql`SELECT user_id, chat_id FROM chat_pins ORDER BY chat_id`
    assert.deepStrictEqual(
      pins.map((r) => [r.user_id, r.chat_id]),
      [
        ["owner", "legacy"],
        ["owner", "pinned"]
      ]
    )
    const branches = yield* sql`SELECT id, pinned_at FROM forks WHERE id IN ('a', 'b', 'c') ORDER BY id`
    assert.deepStrictEqual(
      branches.map((r) => [r.id, r.pinned_at]),
      [
        ["a", 100],
        ["b", 200],
        ["c", null]
      ]
    )
    // A restart must not re-pin a chat the user has since unpinned.
    yield* sql`DELETE FROM chat_pins WHERE chat_id = 'pinned'`
    yield* Effect.scoped(Layer.build(Migrations))
    const remaining = yield* sql`SELECT chat_id FROM chat_pins`
    assert.deepStrictEqual(
      remaining.map((r) => r.chat_id),
      ["legacy"]
    )
    assert.deepStrictEqual(
      yield* sql`SELECT id, pinned_at FROM forks WHERE id IN ('a', 'b', 'c') ORDER BY id`,
      branches
    )
  }).pipe(Effect.provide(layer()))
)
