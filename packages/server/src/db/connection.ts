// Connection setup shared by the writer and reader workers, plus the process-level
// guards that run on the main thread before any worker starts.
import { statfsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { StorageError } from "./ops.ts"

export const databaseFile = (dataDir: string) => join(dataDir, "rp-harness.db")

/** The writer's connection: WAL, full durability, foreign keys. The only read-write connection. */
export const writerConnection = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("PRAGMA foreign_keys = ON")
      // FULL: a committed transaction survives power loss. Writes are small and
      // infrequent enough that the extra fsync per commit doesn't matter.
      yield* sql.unsafe("PRAGMA synchronous = FULL")
      yield* sql.unsafe("PRAGMA temp_store = MEMORY")
      yield* sql.unsafe("PRAGMA cache_size = -65536")
      // Bounds the WAL file after checkpoints. Auto-checkpoints stay PASSIVE (the default),
      // which never waits for or blocks readers.
      yield* sql.unsafe("PRAGMA journal_size_limit = 67108864")
    })
  ).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))

/** A reader's connection: opened read-only, and query_only as a second guard. */
export const readerConnection = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("PRAGMA query_only = ON")
      yield* sql.unsafe("PRAGMA temp_store = MEMORY")
      yield* sql.unsafe("PRAGMA cache_size = -32768")
    })
  ).pipe(Layer.provideMerge(SqliteClient.layer({ filename, readonly: true })))

/** Maps a driver error to the typed error that crosses the worker boundary. */
export const toStorageError =
  (operation: string) =>
  (error: SqlError.SqlError): StorageError => {
    const tag = error.reason._tag
    return new StorageError({
      operation,
      reason:
        tag === "LockTimeoutError"
          ? "busy"
          : tag === "ConstraintError"
            ? "constraint"
            : /corrupt|malformed/i.test(error.message)
              ? "corrupt"
              : "other",
      message: error.message
    })
  }

// ---------------------------------------------------------------------------
// Process-level guards (main thread)
// ---------------------------------------------------------------------------

export class InstanceLocked extends Schema.TaggedError<InstanceLocked>()("InstanceLocked", {
  dataDir: Schema.String
}) {
  override get message() {
    return `Another rp-harness process is already using ${this.dataDir}. Only one instance may open a data directory.`
  }
}

/**
 * Holds an exclusive SQLite lock on `instance.lock` for the life of the process.
 * It's an OS file lock, so the kernel releases it if the process dies, and a second
 * process (another container on the same volume, a second `npm start`) fails fast
 * instead of contending for the database.
 */
export const acquireInstanceLock = (dataDir: string) =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const db = new DatabaseSync(join(dataDir, "instance.lock"))
      try {
        db.exec("PRAGMA locking_mode = EXCLUSIVE")
        db.exec("BEGIN EXCLUSIVE")
        return Effect.succeed(db)
      } catch (cause) {
        db.close()
        return isBusy(cause) ? Effect.fail(new InstanceLocked({ dataDir })) : Effect.die(cause)
      }
    }),
    (db) =>
      Effect.sync(() => {
        db.exec("ROLLBACK")
        db.close()
      })
  )

const isBusy = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "errcode" in cause && (cause.errcode === 5 || cause.errcode === 6)

export class UnsafeFilesystem extends Schema.TaggedError<UnsafeFilesystem>()("UnsafeFilesystem", {
  dataDir: Schema.String,
  filesystem: Schema.String
}) {
  override get message() {
    return (
      `${this.dataDir} is on ${this.filesystem}, where SQLite's file locking is unreliable and the ` +
      `database can be corrupted. Use a local disk, or set DB_ALLOW_NETWORK_FS=1 to override.`
    )
  }
}

// statfs f_type magic numbers (Linux).
const UNSAFE_FILESYSTEMS: ReadonlyMap<number, string> = new Map([
  [0x6969, "NFS"],
  [0xff534d42, "CIFS"],
  [0xfe534d42, "SMB2"],
  [0x517b, "SMB"]
])

export const classifyFilesystem = (type: number): string | undefined => UNSAFE_FILESYSTEMS.get(type)

/** Refuses network filesystems, where POSIX locks (and so SQLite's WAL) can't be trusted. */
export const checkFilesystem = (dataDir: string, allowNetwork: boolean) =>
  Effect.gen(function* () {
    if (process.platform !== "linux" || allowNetwork) return
    const unsafe = classifyFilesystem(statfsSync(dataDir).type)
    if (unsafe) return yield* new UnsafeFilesystem({ dataDir, filesystem: unsafe })
  })
