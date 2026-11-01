import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { authorNoteMigration } from "./authorNoteMigration.ts"
import { baseline } from "./baseline.ts"

/** node:sqlite prepares one statement at a time, so DDL is kept as a list of statements. */
const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

// Migrations run in the writer worker, before any reader connection is opened.
// While no one uses the app the schema is edited in the baseline and the deploy starts fresh.
// A data change the owner's kept database needs runs after it.
export const migrations = {
  "0001_baseline": runAll(baseline),
  // Notes and lore at the author's note's top or bottom get the place it resolves to (owner, 2026-11-01).
  "0004_concrete_author_note": authorNoteMigration
}

/**
 * A database whose ledger holds ids this code doesn't know was made before the baseline
 * (or by a newer build). The migrator would skip what it thinks is older and run the rest
 * on top of a schema it never made, so it is refused before the migrator starts.
 */
const refuseUnknownLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [ledger] = yield* sql<{
    n: number
  }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'effect_sql_migrations'`
  if (ledger!.n === 0) return
  const known = new Set(Object.keys(migrations).map((key) => Number(key.slice(0, key.indexOf("_")))))
  const rows = yield* sql<{ migration_id: number; name: string }>`SELECT migration_id, name FROM effect_sql_migrations`
  const unknown = rows.filter(
    (row) => !known.has(row.migration_id) || !(`${String(row.migration_id).padStart(4, "0")}_${row.name}` in migrations)
  )
  if (unknown.length === 0) return
  const ids = unknown.map((row) => `${String(row.migration_id).padStart(4, "0")}_${row.name}`).join(", ")
  return yield* Effect.die(
    new Error(
      `This database was made by a different version of the schema (ledger holds ${ids}; this build knows ${Object.keys(migrations).join(", ")}). ` +
        `Migrations were squashed into one baseline and old databases are not carried over: start from an empty data directory.`
    )
  )
})

export const Migrations = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
  Layer.provide(Layer.effectDiscard(refuseUnknownLedger))
)
