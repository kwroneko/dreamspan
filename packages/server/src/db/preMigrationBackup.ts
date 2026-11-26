// Called only by the writer's startup migrations, before readers or write handlers start.
import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"

const syncPath = (path: string, flags: "r" | "r+") => {
  const fd = openSync(path, flags)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export const preMigrationBackup = Effect.fnUntraced(function* (
  sqlite: SqliteClient.SqliteClient,
  from: string,
  to: string
) {
  if (sqlite.config.filename === ":memory:") return

  const dataDir = dirname(sqlite.config.filename)
  const backupDir = join(dataDir, "backups")
  const timestamp = new Date().toISOString().replace(/[-:]/g, "")
  const destination = join(backupDir, `pre-migration-${from}-to-${to}-${timestamp}-${randomUUID()}.db`)

  yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        mkdirSync(backupDir, { recursive: true, mode: 0o700 })
        return mkdtempSync(join(backupDir, ".pre-migration-"))
      },
      catch: (cause) => cause
    }),
    (staging) =>
      Effect.gen(function* () {
        const snapshot = join(staging, "snapshot.db")
        yield* sqlite.backup(snapshot)
        yield* Effect.try({
          try: () => {
            chmodSync(snapshot, 0o600)
            const copy = new DatabaseSync(snapshot)
            try {
              // The backup API copies the WAL journal mode as well. Restore this as one file.
              if (copy.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode !== "delete")
                throw new Error("Could not make the snapshot independent of SQLite sidecar files.")
              const integrity = copy.prepare("PRAGMA integrity_check").all()
              if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
                throw new Error("The snapshot failed SQLite's integrity check.")
            } finally {
              copy.close()
            }
            syncPath(snapshot, "r+")
            renameSync(snapshot, destination)
            // Make the backup durable before allowing the live database to change.
            if (process.platform !== "win32") {
              syncPath(backupDir, "r")
              syncPath(dataDir, "r")
            }
          },
          catch: (cause) => cause
        })
      }),
    (staging) =>
      Effect.try({
        try: () => rmSync(staging, { recursive: true, force: true }),
        catch: (cause) => cause
      }).pipe(
        Effect.catch((cause) => Effect.logWarning(`Could not clean up backup staging directory ${staging}`, cause))
      )
  ).pipe(
    // The native SQLite copy does not support cancellation. Wait for it before cleaning up.
    Effect.uninterruptible,
    Effect.catch((cause) =>
      Effect.die(
        new Error(
          `Could not create the pre-migration database backup in ${backupDir} (${from} to ${to}). No migrations ran. Check free disk space and directory permissions before restarting.`,
          { cause }
        )
      )
    )
  )
  yield* Effect.logInfo(`Created pre-migration database backup ${destination} (${from} to ${to}).`)
})
