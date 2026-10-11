// Connection setup shared by the writer and reader workers, plus the process-level
// guards that run on the main thread before any worker starts.
import { statfsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Predicate, Schema } from "effect"
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

/**
 * Maps a driver error to the typed error that crosses the worker boundary. The driver's
 * own message is generic ("Failed to execute statement"); SQLite's is on the cause.
 * The message stays on the server: clients only ever see ServerError.
 */
export const toStorageError =
  (operation: string) =>
  (error: SqlError.SqlError): StorageError => {
    const { reason } = error
    const sqlite = sqliteError(reason.cause)
    return new StorageError({
      operation,
      reason:
        reason._tag === "LockTimeoutError"
          ? "busy"
          : reason._tag === "ConstraintError" || reason._tag === "UniqueViolation"
            ? "constraint"
            : sqlite !== undefined && CORRUPT_CODES.has(sqlite.errcode & 0xff)
              ? "corrupt"
              : "other",
      message: sqlite === undefined ? error.message : `${error.message}: ${sqlite.message}`
    })
  }

// SQLITE_CORRUPT, SQLITE_NOTADB
const CORRUPT_CODES = new Set([11, 26])

const sqliteError = (cause: unknown) =>
  Predicate.hasProperty(cause, "errcode") &&
  typeof cause.errcode === "number" &&
  Predicate.hasProperty(cause, "message") &&
  typeof cause.message === "string"
    ? { errcode: cause.errcode, message: cause.message }
    : undefined

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
      `${this.dataDir} is on ${this.filesystem}. SQLite needs a local filesystem: elsewhere its file locking ` +
      `can fail and corrupt the database. Use a local disk, or set DB_ALLOW_NETWORK_FS=1 if this one is local.`
    )
  }
}

// statfs f_type magic numbers: linux/magic.h, and ZFS's from OpenZFS. Overlay is the
// container filesystem under Docker, on a local disk.
const LOCAL_FILESYSTEMS: ReadonlySet<number> = new Set([
  0xef53, // ext2, ext3, ext4
  0x58465342, // XFS
  0x9123683e, // Btrfs
  0x2fc12fc1, // ZFS
  0xf2f52010, // F2FS
  0x01021994, // tmpfs
  0x794c7630 // overlayfs
])

const KNOWN_FILESYSTEMS: ReadonlyMap<number, string> = new Map([
  [0x6969, "NFS"],
  [0xff534d42, "CIFS"],
  [0xfe534d42, "SMB2"],
  [0x517b, "SMB"],
  [0x65735546, "FUSE (e.g. sshfs, rclone, virtiofs, Docker Desktop file sharing)"],
  [0x01021997, "9p (e.g. WSL2's /mnt/c)"],
  [0x00c36400, "Ceph"],
  [0x5346414f, "AFS"],
  [0x6b414653, "AFS"]
])

/** Undefined for a filesystem known to be local, else what to call it in the refusal. */
export const classifyFilesystem = (type: number): string | undefined => {
  const magic = type >>> 0
  if (LOCAL_FILESYSTEMS.has(magic)) return undefined
  return KNOWN_FILESYSTEMS.get(magic) ?? `an unrecognized filesystem (statfs type 0x${magic.toString(16)})`
}

/** Refuses filesystems not known to be local, where POSIX locks (and so SQLite's WAL) can't be trusted. */
export const checkFilesystem = (dataDir: string, allowNetwork: boolean) =>
  Effect.gen(function* () {
    if (process.platform !== "linux" || allowNetwork) return
    const unsafe = classifyFilesystem(statfsSync(dataDir).type)
    if (unsafe) return yield* new UnsafeFilesystem({ dataDir, filesystem: unsafe })
  })
