import { execFile, spawnSync } from "node:child_process"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import { inject } from "vitest"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { acquireInstanceLock, databaseFile, InstanceLocked } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { diagnosticReaders } from "./support/diagnostics.ts"
import { stalls } from "./support/liveness.ts"
import { tempDir } from "./support/tempDir.ts"

const freshDir = () => tempDir("db")
const bundleDir = inject("bundleDir")
const database = (dataDir: string, readers = 2, workers: "source" | "bundle" = "source") =>
  Database.layer({ dataDir, readers, allowNetworkFs: false, workers, bundleDir })
const execFileAsync = promisify(execFile)
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
    { timeout: 30_000, tags: ["slow"] }
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
        assert.isAbove(onMain.maxLagMs, 100, `baseline should block: ${onMain.maxLagMs.toFixed(0)} ms`)

        const dir = freshDir()
        yield* Effect.provide(
          Effect.flatMap(Database.Writer, (w) => w.Ready()),
          database(dir, 1)
        )
        const { reader, holding, release } = yield* diagnosticReaders(dir, 2)
        assert.strictEqual(yield* reader.CountTo({ n: HEAVY }), HEAVY)

        // One reader is blocked, as by a query that runs until released. Meanwhile the main
        // thread serves light reads through the other reader. Had the blocked reader blocked
        // the main thread, neither they nor the release after them could ever run.
        const held = yield* Effect.forkChild(reader.Hold())
        yield* holding.pipe(stalls("the reader never started its Hold"))
        yield* Effect.forEach(range(20), () => reader.CountTo({ n: 1 })).pipe(
          stalls("a light read waited on the held reader, or the main thread was blocked")
        )
        assert.isUndefined(held.pollUnsafe(), "the reader is still blocked")
        yield* release
        yield* Fiber.join(held).pipe(stalls("the released reader never answered"))
      }).pipe(Effect.scoped),
    { timeout: 30_000, tags: ["slow"] }
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
  it.live("are refused when the sources changed since they were built", () =>
    Effect.gen(function* () {
      const staleDir = tempDir("bundles")
      cpSync(bundleDir, staleDir, { recursive: true })
      const stampFile = join(staleDir, "stamp.json")
      const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as { sources: Array<string> }
      assert.include(stamp.sources, "packages/server/src/db/reader.ts")
      assert.include(stamp.sources, "package-lock.json")
      // As if a source had changed after the build: the stamped hash no longer matches.
      writeFileSync(stampFile, JSON.stringify({ ...stamp, hash: "0".repeat(64) }))
      const exit = yield* Effect.exit(
        Layer.build(
          Database.layer({
            dataDir: freshDir(),
            readers: 1,
            allowNetworkFs: false,
            workers: "bundle",
            bundleDir: staleDir
          })
        )
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "npm run build")
    }).pipe(Effect.scoped)
  )

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

  it("bundle none of the HTTP API", () => {
    for (const name of ["writer", "reader"]) {
      const map = JSON.parse(readFileSync(join(bundleDir, `${name}.mjs.map`), "utf8")) as { sources: Array<string> }
      assert.notInclude(map.sources.join("\n"), "shared/src/api.ts", `${name} bundle`)
    }
  })

  // Measured in a fresh process (support/workerMemoryProbe.ts), median of 3: inside the test
  // process, how much RSS grows depends on what earlier tests freed (in the full suite it read
  // 43 MB, the test alone 89 MB). The probe's figure is the RSS growth from opening the writer
  // and 4 readers, divided by 5; it includes the main thread's share of opening them. Measured
  // 2026-11-19 on the test host: 86 to 87 MB (a reader alone about 60 MB, the writer about 80 MB; their
  // live heap about 20 MB each). A worker loading Effect from source would add about 85 MB.
  it.live(
    "stay within the per-worker memory budget",
    () =>
      Effect.gen(function* () {
        const probe = fileURLToPath(new URL("./support/workerMemoryProbe.ts", import.meta.url))
        const runs = yield* Effect.forEach(range(3), () =>
          Effect.promise(() => execFileAsync(process.execPath, [probe, freshDir(), bundleDir, "4"]))
        )
        const perWorkerMb = runs.map((run) => Number(run.stdout.trim())).sort((a, b) => a - b)[1]!
        assert.isBelow(perWorkerMb, 100, `bundled worker uses ${perWorkerMb.toFixed(0)} MB`)
      }),
    60_000
  )
})
