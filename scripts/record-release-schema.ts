// npm run schema:record: records what a release's migrations are and the schema a fresh install of
// them makes (packages/server/test/fixtures/releases/release-<n>.json, ARCHITECTURE.md §3.7
// "Released schemas"), and the baseline's own schema (test/fixtures/preSquashSchema.json).
//
//   npm run schema:record                 record the newest release again (only while it is provisional)
//   npm run schema:record -- --final      record the newest release again and mark it in use: from then
//                                         on its migrations never change (when real data starts on it).
//                                         This can't be undone: no form of this script records it again.
//   npm run schema:record -- --new        record the current migrations as the next release (only once
//                                         the newest is final, and with its migrations unchanged)
//
// Each form first prints what would change and writes nothing; add --yes to write it
// (`npm run schema:record -- --final --yes`). With no release recorded yet, the first form records
// release 0, provisional. The databases are made in a worker thread, in a temporary directory that
// is removed after.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMainThread, Worker, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { writerConnection } from "../packages/server/src/db/connection.ts"
import { migrate, migrationDefinitions } from "../packages/server/src/db/migrations.ts"
import {
  fingerprint,
  readReleases,
  readSchema,
  recordingRefusal,
  releaseChanges,
  releaseFile,
  type RecordMode,
  type Release,
  type SchemaEntry
} from "../packages/server/src/db/releases.ts"

const baselineFixture = join(import.meta.dirname, "../packages/server/test/fixtures/preSquashSchema.json")

interface Job {
  readonly mode: RecordMode
  readonly release: number
  readonly provisional: boolean
  readonly yes: boolean
}

if (isMainThread) {
  const flags = new Set(process.argv.slice(2))
  const unknown = [...flags].filter((flag) => flag !== "--new" && flag !== "--final" && flag !== "--yes")
  if (unknown.length > 0 || (flags.has("--new") && flags.has("--final"))) {
    console.error("Usage: npm run schema:record [-- [--new | --final] [--yes]]")
    process.exit(2)
  }
  const mode: RecordMode = flags.has("--new") ? "new" : flags.has("--final") ? "final" : "again"
  const releases = readReleases()
  const refusal = recordingRefusal(mode, migrationDefinitions, releases)
  if (refusal !== undefined) {
    console.error(refusal)
    process.exit(1)
  }
  const newest = releases.at(-1)
  const job: Job = {
    mode,
    release: mode === "new" ? newest!.release + 1 : (newest?.release ?? 0),
    provisional: mode === "again",
    yes: flags.has("--yes")
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: job })
  worker.on("error", (error) => {
    console.error(error)
    process.exitCode = 1
  })
  worker.on("exit", (code) => {
    if (code !== 0) process.exitCode = code
  })
} else {
  const { mode, release, provisional, yes } = workerData as Job
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
    const releases = readReleases()
    const previous = mode === "new" ? releases.at(-1) : releases.find((one) => one.release === release)
    const baselineBefore: ReadonlyArray<SchemaEntry> = existsSync(baselineFixture)
      ? (JSON.parse(readFileSync(baselineFixture, "utf8")) as { schema: ReadonlyArray<SchemaEntry> }).schema
      : []
    const changes = releaseChanges(previous, recorded, { before: baselineBefore, after: baseline })
    console.log(
      `Release ${release}${provisional ? " (provisional)" : ""}: ${Object.keys(recorded.migrations).length} migrations, ${schema.length} schema objects; baseline ${baseline.length} objects.`
    )
    console.log(changes.length === 0 ? "Nothing changes." : `What changes:\n${changes.join("\n")}`)
    if (mode === "final")
      console.log(
        `--final marks release ${release} in use for good: no form of this script records it again, and its migrations may never change.`
      )
    if (!yes) console.log("Nothing was written. Run it again with --yes to write this.")
    else {
      writeFileSync(releaseFile(release), JSON.stringify(recorded, null, 2) + "\n")
      writeFileSync(baselineFixture, JSON.stringify({ schema: baseline }, null, 2) + "\n")
      console.log(`Written: ${releaseFile(release)} and ${baselineFixture}.`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
