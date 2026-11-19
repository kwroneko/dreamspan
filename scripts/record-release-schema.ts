// npm run schema:record: records what a release's migrations are and the schema a fresh install of
// them makes (packages/server/test/fixtures/releases/release-<n>.json, ARCHITECTURE.md §3.7
// "Released schemas"), and the baseline's own schema (test/fixtures/preSquashSchema.json).
//
//   npm run schema:record                 record the newest release again (only while it is provisional)
//   npm run schema:record -- --new        record the current migrations as the next release
//   npm run schema:record -- --final      record the newest release again and mark it in use: from then
//                                         on its migrations never change (when real data starts on it)
//
// With no release recorded yet, the first form records release 0, provisional. The databases are
// made in a worker thread, in a temporary directory that is removed after.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMainThread, Worker, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { writerConnection } from "../packages/server/src/db/connection.ts"
import { migrate, migrationDefinitions } from "../packages/server/src/db/migrations.ts"
import { fingerprint, readReleases, readSchema, releaseFile, type Release } from "../packages/server/src/db/releases.ts"

const baselineFixture = join(import.meta.dirname, "../packages/server/test/fixtures/preSquashSchema.json")

if (isMainThread) {
  const flags = new Set(process.argv.slice(2))
  const unknown = [...flags].filter((flag) => flag !== "--new" && flag !== "--final")
  if (unknown.length > 0 || (flags.has("--new") && flags.has("--final"))) {
    console.error("Usage: npm run schema:record [-- --new | -- --final]")
    process.exit(2)
  }
  const releases = readReleases()
  const newest = releases.at(-1)
  let release: number
  let provisional: boolean
  if (flags.has("--new")) {
    if (newest === undefined) {
      console.error("No release is recorded yet: run npm run schema:record first, for release 0.")
      process.exit(1)
    }
    if (Object.keys(migrationDefinitions).every((key) => key in newest.migrations)) {
      console.error(`No migration is new since release ${newest.release}: there is nothing to record.`)
      process.exit(1)
    }
    release = newest.release + 1
    provisional = false
  } else {
    if (newest !== undefined && !newest.provisional) {
      console.error(
        `Release ${newest.release} is in use and is never recorded again. Record a new release with -- --new.`
      )
      process.exit(1)
    }
    release = newest?.release ?? 0
    provisional = !flags.has("--final")
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: { release, provisional } })
  worker.on("error", (error) => {
    console.error(error)
    process.exitCode = 1
  })
  worker.on("exit", (code) => {
    if (code !== 0) process.exitCode = code
  })
} else {
  const { release, provisional } = workerData as { release: number; provisional: boolean }
  const dir = mkdtempSync(join(tmpdir(), "rp-schema-record-"))
  try {
    const schema = await Effect.runPromise(
      migrate(migrationDefinitions).pipe(
        Effect.andThen(readSchema),
        Effect.provide(writerConnection(join(dir, "release.db")))
      )
    )
    const baseline = await Effect.runPromise(
      migrate({ "0001_baseline": migrationDefinitions["0001_baseline"] }).pipe(
        Effect.andThen(readSchema),
        Effect.provide(writerConnection(join(dir, "baseline.db")))
      )
    )
    const recorded: Release = {
      release,
      provisional,
      migrations: Object.fromEntries(
        Object.entries(migrationDefinitions).map(([key, definition]) => [key, fingerprint(definition)])
      ),
      schema
    }
    writeFileSync(releaseFile(release), JSON.stringify(recorded, null, 2) + "\n")
    writeFileSync(baselineFixture, JSON.stringify({ schema: baseline }, null, 2) + "\n")
    console.log(
      `Recorded release ${release}${provisional ? " (provisional)" : ""}: ${Object.keys(recorded.migrations).length} migrations, ${schema.length} schema objects; baseline ${baseline.length} objects.`
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
