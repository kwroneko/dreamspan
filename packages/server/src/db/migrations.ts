import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { baseline } from "./baseline.ts"
import { filesMigration } from "./migrationFiles.ts"
import { previewMacroMigration } from "./migrationPreviewMacro.ts"
import { subagentSchema } from "./subagentSchema.ts"
import { workshopBranchesMigration } from "./migrationWorkshopBranches.ts"

/** node:sqlite prepares one statement at a time, so DDL is kept as a list of statements. */
const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

// Migrations run in the writer worker, before any reader connection is opened.
// The baseline is frozen: every schema change after it is an additive migration here.
export const migrations = {
  "0001_baseline": runAll(baseline),
  // spec/FILES-AND-ENVIRONMENT.md §10: file versions and shares, attachment names and paths.
  "0002_files": runAll(filesMigration),
  // spec/SUBAGENTS.md §11. Numbered after 0002_files, and independent of it.
  "0003_subagents": runAll(subagentSchema),
  // spec/WORKSHOP-BRANCHES.md §7: workshop branches paired with story branches.
  "0004_workshop_branches": runAll(workshopBranchesMigration),
  // Greeting previews with macros replaced: one nullable column on the stored fork summaries.
  "0005_preview_macro": runAll(previewMacroMigration)
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
  // The migrator runs only ids above the newest recorded one, so a migration numbered below it
  // (one merged after a later number was applied, say 0003 after 0004) would be skipped silently.
  const newest = Math.max(-1, ...rows.map((row) => row.migration_id))
  const recorded = new Set(rows.map((row) => row.migration_id))
  const skipped = Object.keys(migrations).filter((key) => {
    const id = Number(key.slice(0, key.indexOf("_")))
    return id < newest && !recorded.has(id)
  })
  if (unknown.length === 0 && skipped.length > 0)
    return yield* Effect.die(
      new Error(
        `This database already ran a migration numbered above ${skipped.join(", ")}, which it never ran, so it would be skipped. ` +
          `Start from an empty data directory, or renumber the migration above the newest one.`
      )
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
