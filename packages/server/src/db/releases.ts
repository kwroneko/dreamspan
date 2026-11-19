// Recorded releases (ARCHITECTURE.md §3.7 "Released schemas"): what each release's migrations
// were and the schema a fresh install of them makes, in test/fixtures/releases/release-<n>.json.
// Read by test/releasedSchema.test.ts, scripts/check-released-migrations.ts (the deploy gate's
// check) and scripts/record-release-schema.ts (`npm run schema:record`), never by the server.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { MigrationDefinition } from "./migrations.ts"

const releasesDir = join(import.meta.dirname, "../../test/fixtures/releases")

export interface SchemaEntry {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string
}

export interface Release {
  readonly release: number
  /**
   * True while nobody keeps data made by it (release 0, until the owner starts keeping data):
   * `npm run schema:record` may record it again. Once false, its migrations never change.
   */
  readonly provisional: boolean
  /** Each migration the release ran, by key, with the fingerprint of its definition. */
  readonly migrations: Readonly<Record<string, string>>
  /** sqlite_master after a fresh install of those migrations (`readSchema`). */
  readonly schema: ReadonlyArray<SchemaEntry>
}

/** Changes whenever anything a migration runs changes, comments in its source file aside. */
export const fingerprint = (definition: MigrationDefinition) =>
  createHash("sha256").update(JSON.stringify(definition)).digest("hex")

export const releaseFile = (release: number) => join(releasesDir, `release-${release}.json`)

/** Every recorded release, oldest first. */
export const readReleases = (): ReadonlyArray<Release> =>
  readdirSync(releasesDir)
    .flatMap((file) => (/^release-\d+\.json$/.test(file) ? [file] : []))
    .map((file) => JSON.parse(readFileSync(join(releasesDir, file), "utf8")) as Release)
    .sort((a, b) => a.release - b.release)

/** The schema as recorded: every named object but SQLite's own and the ledger, whitespace folded. */
export const readSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<SchemaEntry>`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations'`
  return rows
    .map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql: sql.replace(/\s+/g, " ") }))
    .sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name))
})

const idOf = (key: string) => Number(key.slice(0, key.indexOf("_")))

/**
 * Why the current migrations don't fit the recorded releases: a released migration edited,
 * renamed or removed, or a new one numbered at or below the newest release's last.
 */
export const releasedMigrationProblems = (
  definitions: Readonly<Record<string, MigrationDefinition>>,
  releases: ReadonlyArray<Release>
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  for (const release of releases) {
    const redo = release.provisional
      ? ` Release ${release.release} is provisional (nobody keeps its data yet): if this change is meant, record it again with \`npm run schema:record\`.`
      : ` Release ${release.release} is in use: put the change in a new migration instead.`
    for (const [key, recorded] of Object.entries(release.migrations)) {
      const definition = definitions[key]
      if (definition === undefined)
        problems.push(`Migration ${key}, which release ${release.release} ran, is gone or renamed.${redo}`)
      else if (fingerprint(definition) !== recorded)
        problems.push(`Migration ${key}, which release ${release.release} ran, was edited.${redo}`)
    }
  }
  const newest = releases.at(-1)
  if (newest !== undefined) {
    const last = Math.max(...Object.keys(newest.migrations).map(idOf))
    for (const key of Object.keys(definitions))
      if (!(key in newest.migrations) && idOf(key) <= last)
        problems.push(
          `Migration ${key} is new since release ${newest.release} but numbered at or below its last one: number it above ${last}.`
        )
  }
  return problems
}
