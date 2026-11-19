import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { baseline } from "./baseline.ts"
import { filesMigration } from "./migrationFiles.ts"
import { previewMacroMigration } from "./migrationPreviewMacro.ts"
import { subagentSchema } from "./subagentSchema.ts"
import { workshopBranchesMigration } from "./migrationWorkshopBranches.ts"
import { personaLocksMigration } from "./migrationPersonaLocks.ts"
import { contractRecordsMigration } from "./migrationContractRecords.ts"
import { rebuildTable, type OutsideStep } from "./tableRebuild.ts"

/**
 * A migration is data, so a recorded release can fingerprint exactly what it ran
 * (test/fixtures/releases, `releasedMigrationProblems`):
 * - `statements`: SQL run in order inside the migrator's one transaction, with foreign keys on.
 *   node:sqlite prepares one statement at a time, so DDL is kept as a list of statements.
 * - `outsideTransaction`: steps (SQL or table rebuilds, db/tableRebuild.ts) run in a transaction
 *   of their own with foreign keys off, for changes that need a table rebuilt. Every reference is
 *   checked before it commits (ARCHITECTURE.md §3.7 "Table rebuilds").
 */
export type MigrationDefinition =
  { readonly statements: ReadonlyArray<string> } | { readonly outsideTransaction: ReadonlyArray<OutsideStep> }

// Migrations run in the writer worker, before any reader connection is opened.
// A migration a recorded release ran is never edited (test/releasedSchema.test.ts); a schema
// change is a new migration numbered after the newest one.
export const migrationDefinitions = {
  "0001_baseline": { statements: baseline },
  // spec/FILES-AND-ENVIRONMENT.md §10: file versions and shares, attachment names and paths.
  "0002_files": { statements: filesMigration },
  // spec/SUBAGENTS.md §11. Numbered after 0002_files, and independent of it.
  "0003_subagents": { statements: subagentSchema },
  // spec/WORKSHOP-BRANCHES.md §7: workshop branches paired with story branches.
  "0004_workshop_branches": { statements: workshopBranchesMigration },
  // Greeting previews with macros replaced: one nullable column on the stored fork summaries.
  "0005_preview_macro": { statements: previewMacroMigration },
  // DESIGN §2.2 (owner, 2026-11-18): the persona a character's new single chats start with.
  "0006_persona_locks": { statements: personaLocksMigration },
  // spec/REPLY-CONTRACT.md §3.6: how each agent story reply met the send tool's contract.
  "0007_contract_records": { statements: contractRecordsMigration }
} satisfies Readonly<Record<string, MigrationDefinition>>

const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

const idOf = (key: string) => Number(key.slice(0, key.indexOf("_")))
const nameOf = (key: string) => key.slice(key.indexOf("_") + 1)

/**
 * Each migration as an effect the migrator runs in its transaction, for tests that build a
 * database at an older schema. A migration that must run outside the transaction dies here:
 * run it through `migrate`.
 */
export const migrations = Object.fromEntries(
  Object.entries(migrationDefinitions as Readonly<Record<string, MigrationDefinition>>).map(([key, definition]) => [
    key,
    "statements" in definition
      ? runAll(definition.statements)
      : Effect.die(new Error(`${key} runs outside the migrator's transaction: run it through migrate()`))
  ])
) as { readonly [K in keyof typeof migrationDefinitions]: Effect.Effect<void, unknown, SqlClient.SqlClient> }

const pad = (id: number) => String(id).padStart(4, "0")

/**
 * A database whose ledger holds ids this code doesn't know was made by a newer build, or by an
 * older schema this code can't read. The migrator would skip what it thinks is older and run the
 * rest on top of a schema it never made, so it is refused before the migrator starts, with
 * nothing changed. None of these messages ever tell anyone to empty the data folder.
 */
const refuseUnknownLedger = (definitions: Readonly<Record<string, MigrationDefinition>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [ledger] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'effect_sql_migrations'`
    if (ledger!.n === 0) return
    const keys = Object.keys(definitions)
    const known = new Set(keys.map(idOf))
    const newestKnown = Math.max(...known)
    const rows = yield* sql<{
      migration_id: number
      name: string
    }>`SELECT migration_id, name FROM effect_sql_migrations`
    const unknown = rows.filter(
      (row) => !known.has(row.migration_id) || !(`${pad(row.migration_id)}_${row.name}` in definitions)
    )
    // The migrator runs only ids above the newest recorded one, so a migration numbered below it
    // (one merged after a later number was applied, say 0003 after 0004) would be skipped silently.
    const newest = Math.max(-1, ...rows.map((row) => row.migration_id))
    const recorded = new Set(rows.map((row) => row.migration_id))
    const skipped = keys.filter((key) => idOf(key) < newest && !recorded.has(idOf(key)))
    if (unknown.length === 0 && skipped.length > 0)
      return yield* Effect.die(
        new Error(
          `This build has a database change (${skipped.join(", ")}) numbered below one this data already has, so it would never run. ` +
            `Nothing was changed. This is a fault in the build, not in the data: renumber the change above the newest one.`
        )
      )
    if (unknown.length === 0) return
    const ids = unknown.map((row) => `${pad(row.migration_id)}_${row.name}`).join(", ")
    if (unknown.every((row) => row.migration_id > newestKnown))
      return yield* Effect.die(
        new Error(
          `This data was made by a newer version of Dreamspan (it has ${ids}, which this version doesn't know). Nothing was changed. ` +
            `Update Dreamspan to the version that made it, or restore the backup taken before that version's update.`
        )
      )
    return yield* Effect.die(
      new Error(
        `This data was made by a version of Dreamspan whose database this version can't read (it has ${ids}; this version knows ${keys.join(", ")}). ` +
          `Nothing was changed. Run the version that made it, or restore a backup made by this version.`
      )
    )
  })

/**
 * Refuses to go on when a row points at a row that isn't there. After the migrations (and inside
 * each table rebuild, before it commits), so a broken update stops before the server serves data.
 */
const refuseBrokenReferences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const broken = yield* sql<{ table: string; parent: string; n: number }>`SELECT "table", parent, count(*) AS n
    FROM pragma_foreign_key_check GROUP BY "table", parent ORDER BY n DESC, "table"`
  if (broken.length === 0) return
  const total = broken.reduce((sum, row) => sum + row.n, 0)
  const where = broken
    .slice(0, 6)
    .map((row) => `${row.n} in ${row.table} (pointing into ${row.parent})`)
    .join(", ")
  return yield* Effect.die(
    new Error(
      `Dreamspan won't start: ${total} rows in its database point at rows that don't exist: ${where}${broken.length > 6 ? ", and more" : ""}. ` +
        `This build's database changes were not kept, and the data is not served, so nothing more changes. ` +
        `Go back to the version you ran before, or restore the backup taken before this update, and report this problem.`
    )
  )
})

/** Turns foreign keys back on and the legacy rename off, whatever happened. */
const restoreConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe("PRAGMA legacy_alter_table = OFF")
  yield* sql.unsafe("PRAGMA foreign_keys = ON")
}).pipe(Effect.orDie)

/**
 * Runs one `outsideTransaction` migration: foreign keys off (only possible outside a
 * transaction, so it is checked), then its steps, the reference check and its ledger row in one
 * transaction. A failure rolls all of it back, and the next start tries again.
 */
const runOutside = (key: string, steps: ReadonlyArray<OutsideStep>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe("PRAGMA foreign_keys = OFF")
    const [state] = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
    if (state!.foreign_keys !== 0)
      return yield* Effect.die(new Error(`${key} must run outside a transaction, with foreign keys off`))
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const step of steps) yield* typeof step === "string" ? sql.unsafe(step) : rebuildTable(step)
        yield* refuseBrokenReferences
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${idOf(key)}, ${nameOf(key)})`
      })
    )
  }).pipe(
    Effect.ensuring(restoreConnection),
    Effect.catch((error) => Effect.die(new Error(`Migration "${key}" failed`, { cause: error })))
  )

/**
 * Brings a database up to `definitions`, in order. Runs of ordinary migrations go through
 * Effect's migrator, which runs each run in one transaction; an `outsideTransaction` migration
 * between them runs on its own (`runOutside`). The last run and the reference check share one
 * transaction, so a reference problem leaves the database as it was before that run.
 */
export const migrate = (definitions: Readonly<Record<string, MigrationDefinition>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* refuseUnknownLedger(definitions)
    const keys = Object.keys(definitions).sort((a, b) => idOf(a) - idOf(b))
    const inTransaction = (below: number) =>
      SqliteMigrator.fromRecord(
        Object.fromEntries(
          keys.flatMap((key) => {
            const definition = definitions[key]!
            return idOf(key) < below && "statements" in definition ? [[key, runAll(definition.statements)]] : []
          })
        )
      )
    for (const key of keys) {
      const definition = definitions[key]!
      if ("statements" in definition) continue
      yield* SqliteMigrator.run({ loader: inTransaction(idOf(key)) })
      const [latest] = yield* sql<{ id: number | null }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`
      if ((latest?.id ?? 0) < idOf(key)) yield* runOutside(key, definition.outsideTransaction)
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* SqliteMigrator.run({ loader: inTransaction(Infinity) })
        yield* refuseBrokenReferences
      })
    )
  })

export const Migrations = Layer.effectDiscard(migrate(migrationDefinitions))
