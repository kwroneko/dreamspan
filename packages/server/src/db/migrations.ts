import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { baseline } from "./baseline.ts"
import { filesMigration } from "./migrationFiles.ts"
import { previewMacroMigration } from "./migrationPreviewMacro.ts"
import { subagentSchema } from "./subagentSchema.ts"
import { workshopBranchesMigration } from "./migrationWorkshopBranches.ts"
import { personaLocksMigration } from "./migrationPersonaLocks.ts"
import { contractRecordsMigration } from "./migrationContractRecords.ts"
import { attachmentPathsMigration } from "./migrationAttachmentPaths.ts"
import { shareInvitationsMigration } from "./migrationShareInvitations.ts"
import { shareBirthMigration } from "./migrationShareBirth.ts"
import { guidanceTargetMigration } from "./migrationGuidanceTarget.ts"
import { reasoningStatsMigration } from "./migrationReasoningStats.ts"
import { nativeReasoningMigration } from "./migrationNativeReasoning.ts"
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
  "0007_contract_records": { statements: contractRecordsMigration },
  // spec/FILES-AND-ENVIRONMENT.md §6.1: where a workshop's attachment draft was saved in Files.
  "0008_attachment_paths": { statements: attachmentPathsMigration },
  // spec/FILES-AND-ENVIRONMENT.md §1.4: shares bound to their folder, and accepted before they reach anyone.
  "0009_share_invitations": { statements: shareInvitationsMigration },
  // spec/FILES-AND-ENVIRONMENT.md §1.4: a share also bound to its folder's birth time; declined invitations kept for the owner's view.
  "0010_share_birth": { statements: shareBirthMigration },
  // DESIGN §2.2 (owner, 2026-11-21): the reply a composer's guidance is written for, kept with its draft.
  "0011_guidance_target": { statements: guidanceTargetMigration },
  // A reply's reasoning apart in its generation figures: whether its count is an estimate, and when its first reasoning and reply tokens came.
  "0012_reasoning_stats": { statements: reasoningStatsMigration },
  // ARCHITECTURE §15 "Reasoning sent back" (owner, 2026-11-23): a plain reply's reasoning as the provider sent it.
  "0013_native_reasoning": { statements: nativeReasoningMigration },
  // Receipts say which session accepted a composer save, even after the draft moves on.
  "0014_composer_save_session": {
    statements: ["ALTER TABLE composer_save_receipts ADD COLUMN accepted_session INTEGER"]
  },
  "0015_composer_commits": {
    statements: [
      `CREATE TABLE composer_commits (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        session INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (draft_id, session)
      ) STRICT, WITHOUT ROWID`
    ]
  }
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

/** Rows that point at a row that isn't there, counted by table and the table they point into. */
export interface BrokenReference {
  readonly table: string
  readonly parent: string
  readonly rows: number
}

/** What a start did to the database: the migrations it applied, and the broken references left. */
export interface MigrationReport {
  readonly applied: ReadonlyArray<string>
  readonly broken: ReadonlyArray<BrokenReference>
}

/** The writer's migration report, for the admin's Server status page (`GetDatabaseStartup`). */
export class DatabaseStartup extends Context.Service<DatabaseStartup, MigrationReport>()("rp/db/DatabaseStartup") {}

const brokenReferences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<BrokenReference>`SELECT "table", parent, count(*) AS rows
    FROM pragma_foreign_key_check GROUP BY "table", parent ORDER BY rows DESC, "table", parent`
})

const describeBroken = (broken: ReadonlyArray<BrokenReference>) => {
  const total = broken.reduce((sum, row) => sum + row.rows, 0)
  const where = broken
    .slice(0, 6)
    .map((row) => `${row.rows} in ${row.table} (pointing into ${row.parent})`)
    .join(", ")
  return `${total} ${total === 1 ? "row pointing at a row that doesn't" : "rows pointing at rows that don't"} exist: ${where}${broken.length > 6 ? ", and more" : ""}`
}

const list = (keys: ReadonlyArray<string>) => keys.join(", ")
const plural = (keys: ReadonlyArray<string>, one: string, many: string) => (keys.length === 1 ? one : many)

/**
 * The reference check that ends each run of migrations, inside the run's transaction. Broken
 * references that were there before this start (`before`) are not this run's doing: they were
 * logged when the start began, and the run goes on. Any more than that, and the run rolls back
 * and the writer stops, saying exactly what was kept: the runs this start committed before it
 * (`kept`) passed the same check and stay.
 */
const refuseNewBreakage = (
  before: ReadonlyArray<BrokenReference>,
  run: ReadonlyArray<string>,
  kept: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const now = yield* brokenReferences
    const had = new Map(before.map((row) => [`${row.table}\u0000${row.parent}`, row.rows]))
    const added = now.flatMap((row) => {
      const more = row.rows - (had.get(`${row.table}\u0000${row.parent}`) ?? 0)
      return more > 0 ? [{ ...row, rows: more }] : []
    })
    if (added.length === 0) return now
    const these = plural(run, "this database change", "these database changes")
    return yield* Effect.die(
      new Error(
        `Dreamspan won't start: this update's database ${plural(run, "change", "changes")} ${list(run)} would leave ${describeBroken(added)}. ` +
          `So ${these} ${plural(run, "was", "were")} undone, and the data is not served. ` +
          (kept.length === 0
            ? `Nothing else was changed: the data is as the version you ran before left it. Go back to that version, or restore the backup taken before this update, and report this problem.`
            : `The ${plural(kept, "change", "changes")} before ${plural(run, "it", "them")} at this start (${list(kept)}) passed the same check and ${plural(kept, "was", "were")} kept, so the version you ran before can't open this data any more: restore the backup taken before this update, and report this problem.`)
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
 * The code an `outsideTransaction` migration runs besides its own steps: bump this when
 * `runOutside` changes what it does (the pragmas around the steps, the check, the ledger row),
 * so the fingerprint of every released migration that runs through it changes too
 * (db/releases.ts `fingerprint`).
 */
export const OUTSIDE_RUNNER_VERSION = 1

/**
 * Runs one `outsideTransaction` migration: foreign keys off (only possible outside a
 * transaction, so it is checked), then its steps, the reference check and its ledger row in one
 * transaction. A failure rolls all of it back, and the next start tries again.
 */
const runOutside = (
  key: string,
  steps: ReadonlyArray<OutsideStep>,
  check: Effect.Effect<unknown, never, SqlClient.SqlClient>
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe("PRAGMA foreign_keys = OFF")
    const [state] = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
    if (state!.foreign_keys !== 0)
      return yield* Effect.die(new Error(`${key} must run outside a transaction, with foreign keys off`))
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const step of steps) yield* typeof step === "string" ? sql.unsafe(step) : rebuildTable(step)
        yield* check
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${idOf(key)}, ${nameOf(key)})`
      })
    )
  }).pipe(
    Effect.ensuring(restoreConnection),
    Effect.catch((error) => Effect.die(new Error(`Migration "${key}" failed`, { cause: error })))
  )

/** Two migrations with one number: the migrator would run only one of them. A fault in the build. */
export const duplicateMigrationIds = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
  const byId = new Map<number, Array<string>>()
  for (const key of keys) byId.set(idOf(key), [...(byId.get(idOf(key)) ?? []), key])
  return [...byId.values()].filter((same) => same.length > 1).map((same) => same.join(" and "))
}

/**
 * Brings a database up to `definitions`, in order, and says what it did. Runs of ordinary
 * migrations go through Effect's migrator, each run in one transaction; an `outsideTransaction`
 * migration between them runs on its own (`runOutside`). Every run ends with the reference check
 * in its own transaction, so a run that breaks a reference rolls back alone (`refuseNewBreakage`).
 * References already broken when the start began are logged as a warning and kept in the report:
 * the start goes on, so an old problem never stops the server for good.
 */
export const migrate = (definitions: Readonly<Record<string, MigrationDefinition>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const duplicates = duplicateMigrationIds(Object.keys(definitions))
    if (duplicates.length > 0)
      return yield* Effect.die(
        new Error(
          `This build has database changes that share a number (${duplicates.join("; ")}), so only one of each would run. ` +
            `Nothing was changed. This is a fault in the build, not in the data.`
        )
      )
    yield* refuseUnknownLedger(definitions)
    const [ledger] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'effect_sql_migrations'`
    const latest =
      ledger!.n === 0
        ? 0
        : ((yield* sql<{ id: number | null }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`)[0]?.id ?? 0)
    const pending = Object.keys(definitions)
      .filter((key) => idOf(key) > latest)
      .sort((a, b) => idOf(a) - idOf(b))

    let broken = yield* brokenReferences
    if (broken.length > 0)
      yield* Effect.logWarning(
        `Dreamspan's database has ${describeBroken(broken)}. ` +
          (pending.length === 0
            ? `No database change ran at this start, so this was already there; Dreamspan starts anyway. `
            : `They were there before this start's database changes (${list(pending)}), which run anyway. `) +
          `Items that use those rows may not open or change. Restore a backup from before the problem, or report it. Admins see this on the Server status page.`
      )

    // Consecutive ordinary migrations form one run; each outside-transaction migration is its own.
    const runs: Array<{ keys: Array<string>; outside?: ReadonlyArray<OutsideStep> }> = []
    for (const key of pending) {
      const definition = definitions[key]!
      if ("outsideTransaction" in definition) runs.push({ keys: [key], outside: definition.outsideTransaction })
      else if (runs.at(-1) !== undefined && runs.at(-1)!.outside === undefined) runs.at(-1)!.keys.push(key)
      else runs.push({ keys: [key] })
    }
    // The ledger an outside-transaction migration writes its row to (the migrator makes it itself).
    if (ledger!.n === 0 && runs.some((run) => run.outside !== undefined))
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({}) })
    const applied: Array<string> = []
    for (const run of runs) {
      const before = broken
      const check = refuseNewBreakage(before, run.keys, [...applied]).pipe(
        Effect.tap((now) => Effect.sync(() => (broken = now))),
        Effect.orDie
      )
      if (run.outside !== undefined) yield* runOutside(run.keys[0]!, run.outside, check)
      else
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* SqliteMigrator.run({
              loader: SqliteMigrator.fromRecord(
                Object.fromEntries(
                  run.keys.map((key) => [
                    key,
                    runAll((definitions[key] as { statements: ReadonlyArray<string> }).statements)
                  ])
                )
              )
            })
            yield* check
          })
        )
      applied.push(...run.keys)
    }
    return { applied, broken } satisfies MigrationReport
  })

export const Migrations = Layer.effect(DatabaseStartup, migrate(migrationDefinitions))
