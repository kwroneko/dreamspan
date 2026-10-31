import { closeSync, openSync, writeSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { classifyFilesystem, databaseFile, toStorageError } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = (dataDir: string) => Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })

describe("storage errors", () => {
  it.effect("carry SQLite's own message and classify constraint failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("PRAGMA foreign_keys = ON")
      yield* sql.unsafe("CREATE TABLE p (id INTEGER PRIMARY KEY)")
      yield* sql.unsafe(
        "CREATE TABLE t (name TEXT NOT NULL UNIQUE, n INTEGER CHECK (n > 0), p INTEGER REFERENCES p (id))"
      )
      yield* sql.unsafe("INSERT INTO t (name, n) VALUES ('a', 1)")
      const failure = (statement: string) => sql.unsafe(statement).pipe(Effect.flip, Effect.map(toStorageError("Test")))

      const cases = [
        ["INSERT INTO t (name, n) VALUES ('a', 1)", "constraint", "UNIQUE constraint failed: t.name"],
        ["INSERT INTO t (name, n) VALUES ('b', 0)", "constraint", "CHECK constraint failed"],
        ["INSERT INTO t (name, n) VALUES (NULL, 1)", "constraint", "NOT NULL constraint failed: t.name"],
        ["INSERT INTO t (name, n, p) VALUES ('c', 1, 99)", "constraint", "FOREIGN KEY constraint failed"],
        ["SELECT * FROM missing", "other", "no such table: missing"]
      ] as const
      for (const [statement, reason, message] of cases) {
        const error = yield* failure(statement)
        assert.strictEqual(error.reason, reason, statement)
        assert.include(error.message, message)
      }
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
  )

  it.live(
    "a corrupted page reaches the caller as corrupt, through the workers",
    () =>
      Effect.gen(function* () {
        const dir = tempDir("corrupt")
        yield* Effect.flatMap(Database.Writer, (writer) =>
          writer.EnsureUser({ handle: "alice", displayName: "Alice" })
        ).pipe(Effect.provide(database(dir)))

        // Overwrite the users table's only page.
        const file = databaseFile(dir)
        const db = new DatabaseSync(file)
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'users'").get() as {
          rootpage: number
        }
        const { page_size } = db.prepare("PRAGMA page_size").get() as { page_size: number }
        db.close()
        const fd = openSync(file, "r+")
        writeSync(fd, Buffer.alloc(page_size, 0xff), 0, page_size, (rootpage - 1) * page_size)
        closeSync(fd)

        const error = yield* Effect.flatMap(Database.Reader, (reader) =>
          reader.FindUserByHandle({ handle: "alice" })
        ).pipe(Effect.flip, Effect.provide(database(dir)))
        assert.strictEqual(error._tag, "StorageError")
        if (error._tag !== "StorageError") return
        assert.strictEqual(error.reason, "corrupt")
        assert.include(error.message, "malformed")
      }),
    30_000
  )
})

describe("filesystem check", () => {
  it("accepts only filesystems known to be local", () => {
    for (const local of [0xef53, 0x58465342, 0x9123683e, 0x2fc12fc1, 0x01021994, 0x794c7630]) {
      assert.isUndefined(classifyFilesystem(local), local.toString(16))
    }
    assert.strictEqual(classifyFilesystem(0x6969), "NFS")
    assert.strictEqual(classifyFilesystem(0xff534d42), "CIFS")
    assert.include(classifyFilesystem(0x65735546), "FUSE")
    assert.include(classifyFilesystem(0x01021997), "9p")
    assert.strictEqual(classifyFilesystem(0x00c36400), "Ceph")
    assert.include(classifyFilesystem(0x12345678), "unrecognized filesystem (statfs type 0x12345678)")
    // statfs can report a large magic number as negative.
    assert.strictEqual(classifyFilesystem(0xff534d42 | 0), "CIFS")
  })
})
