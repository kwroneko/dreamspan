import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../src/db/Database.ts"
import { databaseFile, writerConnection } from "../src/db/connection.ts"
import { migrate, migrationDefinitions, Migrations } from "../src/db/migrations.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"

const migrationNumber = (key: string) => Number(key.split("_", 1)[0])
const targetMigration = Math.max(...Object.keys(migrationDefinitions).map(migrationNumber))

const start = (dataDir: string) =>
  Effect.scoped(
    Layer.build(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })).pipe(Effect.asVoid)
  )

const seed = (dataDir: string, breakMigration = false) =>
  Effect.gen(function* () {
    const connection = yield* Layer.build(writerConnection(databaseFile(dataDir)))
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA wal_autocheckpoint = 0`
      yield* migrate(
        Object.fromEntries(Object.entries(migrationDefinitions).filter(([key]) => migrationNumber(key) <= 31))
      )
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at)
        VALUES ('u', 'synthetic', 'Synthetic User', 'user', 0)`
      // Migration 0033 will fail after migration 0032 has already run in the same transaction.
      if (breakMigration) yield* sql`CREATE TABLE attachment_publications (fixture INTEGER)`
    }).pipe(Effect.provide(connection))
  })

const inspect = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return {
      integrity: db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      latest: db.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get()?.id,
      staged: db.prepare("SELECT name FROM pragma_table_info('composer_images') WHERE name = 'staged'").get()?.name,
      users: db
        .prepare("SELECT display_name FROM users")
        .all()
        .map((row) => row.display_name)
    }
  } finally {
    db.close()
  }
}

const preMigration = { integrity: "ok", latest: 31, staged: undefined, users: ["Synthetic User"] }

const assertBackup = (dataDir: string) => {
  const dir = join(dataDir, "backups")
  const entries = existsSync(dir) ? readdirSync(dir) : []
  assert.lengthOf(entries, 1)
  assert.isTrue(entries[0]!.startsWith(`pre-migration-0031-to-${String(targetMigration).padStart(4, "0")}-`))
  assert.match(entries[0]!, /-\d{8}T\d{6}\.\d{3}Z-[a-f0-9-]+\.db$/)
  const file = join(dir, entries[0]!)
  assert.strictEqual(statSync(file).mode & 0o777, 0o600)
  assert.deepStrictEqual(inspect(file), preMigration)
  assert.deepStrictEqual(readdirSync(dir), entries)
}

it.live("starts a fresh database without a backup", () =>
  Effect.gen(function* () {
    const dataDir = tempDir("migration-backup")
    yield* start(dataDir)
    assert.isFalse(existsSync(join(dataDir, "backups")))
  })
)

it.live("restarts an up-to-date database without a backup", () =>
  Effect.gen(function* () {
    const dataDir = tempDir("migration-backup")
    yield* start(dataDir)
    yield* start(dataDir)
    assert.isFalse(existsSync(join(dataDir, "backups")))
  })
)

it.live("backs up the old schema and WAL data before migrating, keeping an independent copy", () =>
  Effect.gen(function* () {
    const dataDir = tempDir("migration-backup")
    yield* seed(dataDir)
    assert.isAbove(statSync(databaseFile(dataDir) + "-wal").size, 0)
    yield* start(dataDir)
    assertBackup(dataDir)
    assert.deepStrictEqual(inspect(databaseFile(dataDir)), {
      ...preMigration,
      latest: targetMigration,
      staged: "staged"
    })
    yield* start(dataDir)
    assertBackup(dataDir)
  }).pipe(Effect.scoped)
)

it.live("retains the backup and rolls back the live database when a migration fails", () =>
  Effect.gen(function* () {
    const dataDir = tempDir("migration-backup")
    yield* Effect.scoped(seed(dataDir, true))
    assert.deepStrictEqual(inspect(databaseFile(dataDir)), preMigration)
    const result = yield* Effect.exit(start(dataDir))
    assert.isTrue(Exit.isFailure(result), JSON.stringify(inspect(databaseFile(dataDir))))
    assertBackup(dataDir)
    assert.deepStrictEqual(inspect(databaseFile(dataDir)), preMigration)
  })
)

it.live("refuses startup before running any migration if a file blocks the backup directory", () =>
  Effect.gen(function* () {
    const dataDir = tempDir("migration-backup")
    yield* Effect.scoped(seed(dataDir))
    writeFileSync(join(dataDir, "backups"), "synthetic obstruction")
    assert.deepStrictEqual(inspect(databaseFile(dataDir)), preMigration)
    const result = yield* Effect.exit(start(dataDir))
    assert.isTrue(Exit.isFailure(result), JSON.stringify(inspect(databaseFile(dataDir))))
    // The worker logs the migration-layer error before it exits. The caller sees a worker exit.
    const message = yield* Effect.scoped(
      Layer.build(Migrations).pipe(Effect.provide(writerConnection(databaseFile(dataDir))))
    ).pipe(Effect.matchCause({ onFailure: Cause.pretty, onSuccess: () => "" }))
    assert.include(message, "Could not create the pre-migration database backup")
    assert.include(message, "No migrations ran")
    assert.deepStrictEqual(inspect(databaseFile(dataDir)), preMigration)
  })
)
