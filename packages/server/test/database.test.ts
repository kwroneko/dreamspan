import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, beforeAll, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { acquireInstanceLock, classifyFilesystem, databaseFile, InstanceLocked } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { buildWorkers } from "../scripts/build-workers.ts"

const freshDir = () => mkdtempSync(join(tmpdir(), "rp-db-"))
const database = (dataDir: string, readers = 2, workers: "source" | "bundle" = "source") =>
  Database.layer({ dataDir, readers, allowNetworkFs: false, workers })
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** Largest gap between 5 ms timer ticks on this thread while `effect` runs. */
const measureMainThreadLag = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    let last = performance.now()
    let maxLag = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - last - 5)
      last = now
    }, 5)
    const start = performance.now()
    const result = yield* effect
    const elapsedMs = performance.now() - start
    // Keep sampling briefly: a blocked loop only shows up when the next tick finally runs.
    yield* Effect.sleep(30).pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))))
    return { result, maxLagMs: maxLag, elapsedMs }
  })

const HEAVY = 3_000_000
const heavySql = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${HEAVY}) SELECT count(*) AS n FROM c`

describe("instance lock", () => {
  it.live("refuses a second holder in the same process", () =>
    Effect.gen(function* () {
      const dir = freshDir()
      yield* acquireInstanceLock(dir)
      const second = yield* Effect.exit(Effect.scoped(acquireInstanceLock(dir)))
      const error = Exit.isFailure(second) ? Cause.findErrorOption(second.cause) : undefined
      assert.isTrue(error?._tag === "Some" && error.value instanceof InstanceLocked)
    }).pipe(Effect.scoped)
  )

  it.live("refuses another process, and releases when the holder goes away", () =>
    Effect.gen(function* () {
      const dir = freshDir()
      const tryLock = () =>
        spawnSync(
          process.execPath,
          [
            "-e",
            `const { DatabaseSync } = require("node:sqlite");
             const db = new DatabaseSync(${JSON.stringify(join(dir, "instance.lock"))});
             try { db.exec("PRAGMA locking_mode = EXCLUSIVE"); db.exec("BEGIN EXCLUSIVE"); console.log("acquired") }
             catch (e) { console.log("refused " + e.errcode) }`
          ],
          { encoding: "utf8" }
        ).stdout.trim()

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireInstanceLock(dir)
          assert.strictEqual(tryLock(), "refused 5")
        })
      )
      assert.strictEqual(tryLock(), "acquired")
    })
  )
})

describe("database workers", () => {
  it.live(
    "serves 1000 concurrent writes and reads without SQLITE_BUSY",
    () =>
      Effect.gen(function* () {
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const writes = Effect.forEach(
          range(500),
          (i) => writer.EnsureUser({ handle: `u${i}`, displayName: `User ${i}` }),
          {
            concurrency: "unbounded"
          }
        )
        const reads = Effect.forEach(range(500), (i) => reader.FindUserByHandle({ handle: `u${i % 50}` }), {
          concurrency: "unbounded"
        })
        const [users] = yield* Effect.all([writes, reads], { concurrency: "unbounded" })

        assert.strictEqual(new Set(users.map((u) => u.id)).size, 500)
        assert.strictEqual(users.filter((u) => u.role === "admin").length, 1)
        // A write that has returned is visible to every reader.
        const last = yield* reader.FindUserByHandle({ handle: "u499" })
        assert.strictEqual(last?.displayName, "User 499")
        // Idempotent: ensuring an existing user returns the same row.
        const again = yield* writer.EnsureUser({ handle: "u7", displayName: "ignored" })
        assert.strictEqual(again.id, users[7]!.id)
      }).pipe(Effect.provide(database(freshDir()))),
    30_000
  )

  it.live(
    "runs heavy queries without blocking the main thread",
    () =>
      Effect.gen(function* () {
        // Baseline: the same query on the main thread blocks the event loop for its duration.
        const direct = new DatabaseSync(":memory:")
        const onMain = yield* measureMainThreadLag(
          Effect.andThen(
            Effect.sleep(20),
            Effect.sync(() => direct.prepare(heavySql).get())
          )
        )
        direct.close()

        const reader = yield* Database.Reader
        yield* reader.FindUserByHandle({ handle: "warm-up" })
        const offMain = yield* measureMainThreadLag(
          Effect.all(
            [
              reader.CountTo({ n: HEAVY }).pipe(Effect.map((n) => ({ n, doneAt: performance.now() }))),
              // Light reads go to the other reader and finish while the heavy one runs.
              Effect.forEach(range(20), () => reader.FindUserByHandle({ handle: "nobody" })).pipe(
                Effect.andThen(Effect.sync(() => performance.now()))
              )
            ],
            { concurrency: "unbounded" }
          )
        )

        const [heavy, lightDoneAt] = offMain.result
        assert.strictEqual(heavy.n, HEAVY)
        assert.isBelow(lightDoneAt, heavy.doneAt, "light reads should not wait behind the heavy one")
        assert.isAbove(onMain.maxLagMs, 100, `baseline should block: ${onMain.maxLagMs.toFixed(0)} ms`)
        assert.isBelow(offMain.maxLagMs, 30, `main thread lag with workers: ${offMain.maxLagMs.toFixed(1)} ms`)
      }).pipe(Effect.provide(database(freshDir()))),
    30_000
  )

  it.live(
    "creates the database file in the data directory",
    () =>
      Effect.gen(function* () {
        const dir = freshDir()
        yield* Effect.provide(
          Effect.flatMap(Database.Writer, (w) => w.Ready()),
          database(dir, 1)
        )
        const db = new DatabaseSync(databaseFile(dir), { readOnly: true })
        const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
        db.close()
        assert.strictEqual(mode.journal_mode, "wal")
      }),
    30_000
  )
})

describe("bundled workers", () => {
  beforeAll(() => buildWorkers(), 60_000)

  it.live(
    "serve the same operations as the source workers",
    () =>
      Effect.gen(function* () {
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const users = yield* Effect.forEach(
          range(100),
          (i) => writer.EnsureUser({ handle: `b${i}`, displayName: `B ${i}` }),
          {
            concurrency: "unbounded"
          }
        )
        assert.strictEqual(new Set(users.map((u) => u.id)).size, 100)
        assert.strictEqual((yield* reader.FindUserByHandle({ handle: "b99" }))?.displayName, "B 99")
      }).pipe(Effect.provide(database(freshDir(), 2, "bundle"))),
    30_000
  )

  it.live(
    "stay within the per-worker memory budget",
    () =>
      Effect.gen(function* () {
        const readers = 4
        const before = process.memoryUsage().rss
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* Database.Reader
            // Touch every reader so all of them have loaded and opened their connection.
            yield* Effect.forEach(range(readers * 4), () => reader.CountTo({ n: 1000 }), { concurrency: "unbounded" })
            yield* Effect.sleep(500)
            const perWorkerMb = (process.memoryUsage().rss - before) / 1048576 / (readers + 1)
            assert.isBelow(perWorkerMb, 40, `bundled worker uses ${perWorkerMb.toFixed(0)} MB`)
          }).pipe(Effect.provide(database(freshDir(), readers, "bundle")))
        )
      }),
    30_000
  )
})

describe("filesystem check", () => {
  it("flags network filesystems by statfs type", () => {
    assert.strictEqual(classifyFilesystem(0x6969), "NFS")
    assert.strictEqual(classifyFilesystem(0xff534d42), "CIFS")
    assert.strictEqual(classifyFilesystem(0xef53), undefined) // ext4
  })
})
