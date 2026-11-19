// Recorded releases (ARCHITECTURE.md §3.7 "Released schemas"): what each release's migrations
// were and the schema a fresh install of them makes, in test/fixtures/releases/release-<n>.json.
// Read by test/releasedSchema.test.ts, scripts/check-released-migrations.ts (the deploy gate's
// check) and scripts/record-release-schema.ts (`npm run schema:record`), never by the server.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { duplicateMigrationIds, OUTSIDE_RUNNER_VERSION, type MigrationDefinition } from "./migrations.ts"
import { TABLE_REBUILD_VERSION } from "./tableRebuild.ts"

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

/**
 * JSON with every object's keys sorted, so the same data always gives the same text. Refuses what
 * JSON would drop or turn into `{}` (undefined, functions, Sets, Maps, RegExps, class instances):
 * a field of such a type would otherwise change without changing the fingerprint.
 */
export const stableJson = (value: unknown, path = "definition"): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} is ${value}, which JSON can't hold`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item, i) => stableJson(item, `${path}[${i}]`)).join(",")}]`
  if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key], `${path}.${key}`)}`)
    return `{${entries.join(",")}}`
  }
  const kind = typeof value === "object" ? (value.constructor?.name ?? "object") : typeof value
  throw new Error(`${path} is a ${kind}, which a migration's fingerprint can't read: use plain data`)
}

/**
 * Changes whenever anything a migration runs changes, comments in its source file aside. An
 * ordinary migration is its statements. One that runs outside the migrator's transaction also
 * runs our code (migrations.ts `runOutside`, tableRebuild.ts `rebuildTable`), so its fingerprint
 * also names those functions, which of its steps each one runs, and their version constants,
 * bumped whenever that code changes what it does.
 */
export const fingerprint = (definition: MigrationDefinition) =>
  createHash("sha256").update(fingerprintSource(definition)).digest("hex")

/** What `fingerprint` hashes. */
export const fingerprintSource = (definition: MigrationDefinition) =>
  stableJson(
    "outsideTransaction" in definition
      ? {
          ...definition,
          code: {
            runOutside: OUTSIDE_RUNNER_VERSION,
            rebuildTable: TABLE_REBUILD_VERSION,
            steps: definition.outsideTransaction.map((step) =>
              typeof step === "string" ? "sql" : `rebuildTable(${step.table})`
            )
          }
        }
      : definition
  )

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
  const problems: Array<string> = duplicateMigrationIds(Object.keys(definitions)).map(
    (same) => `Migrations ${same} share a number: only one of them would ever run. Renumber the newer one.`
  )
  for (const release of releases) {
    const redo = release.provisional
      ? ` Release ${release.release} is provisional (nobody keeps its data yet): if this change is meant, record it again with \`npm run schema:record\` (it shows what changes; add \`-- --yes\` to write it).`
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

/** What `npm run schema:record` was asked to do: record the newest release again, freeze it, or add one. */
export type RecordMode = "again" | "final" | "new"

/** Why `npm run schema:record` in `mode` must not record anything, or undefined when it may. */
export const recordingRefusal = (
  mode: RecordMode,
  definitions: Readonly<Record<string, MigrationDefinition>>,
  releases: ReadonlyArray<Release>
): string | undefined => {
  const duplicates = duplicateMigrationIds(Object.keys(definitions))
  if (duplicates.length > 0) return `Migrations ${duplicates.join("; ")} share a number: renumber the newer one first.`
  const newest = releases.at(-1)
  if (mode !== "new")
    return newest !== undefined && !newest.provisional
      ? `Release ${newest.release} is in use and is never recorded again. Record a new release with -- --new.`
      : undefined
  if (newest === undefined) return "No release is recorded yet: run npm run schema:record first, for release 0."
  if (newest.provisional)
    return `Release ${newest.release} is still provisional. Mark it in use with npm run schema:record -- --final first (it can't be undone), then record the next one.`
  const problems = releasedMigrationProblems(definitions, releases)
  if (problems.length > 0) return `The released migrations changed:\n${problems.join("\n")}`
  if (Object.keys(definitions).every((key) => key in newest.migrations))
    return `No migration is new since release ${newest.release}: there is nothing to record.`
  return undefined
}

const schemaChanges = (label: string, before: ReadonlyArray<SchemaEntry>, after: ReadonlyArray<SchemaEntry>) => {
  const key = (entry: SchemaEntry) => `${entry.type} ${entry.name}`
  const old = new Map(before.map((entry) => [key(entry), entry]))
  const next = new Map(after.map((entry) => [key(entry), entry]))
  return [
    ...[...next.keys()].filter((name) => !old.has(name)).map((name) => `  ${label}: + ${name}`),
    ...[...old.keys()].filter((name) => !next.has(name)).map((name) => `  ${label}: - ${name}`),
    ...[...next].flatMap(([name, entry]) =>
      old.has(name) && stableJson(old.get(name)) !== stableJson(entry) ? [`  ${label}: ~ ${name}`] : []
    )
  ]
}

/**
 * What recording `next` changes, one line each, against `previous` (the file it replaces, or the
 * release before a new one) and the baseline's own schema: release state, migrations added,
 * removed or edited, and schema objects added (+), removed (-) or changed (~).
 */
export const releaseChanges = (
  previous: Release | undefined,
  next: Release,
  baseline: { readonly before: ReadonlyArray<SchemaEntry>; readonly after: ReadonlyArray<SchemaEntry> }
): ReadonlyArray<string> => {
  const lines: Array<string> = []
  if (previous === undefined) lines.push(`  release ${next.release}: new file`)
  else if (previous.release !== next.release)
    lines.push(`  release ${next.release}: new file, after release ${previous.release}`)
  if (previous?.release === next.release && previous.provisional !== next.provisional)
    lines.push(`  release ${next.release}: ${next.provisional ? "provisional again" : "in use from now on (final)"}`)
  const old = previous?.migrations ?? {}
  for (const [key, print] of Object.entries(next.migrations))
    if (!(key in old)) lines.push(`  migration: + ${key}`)
    else if (old[key] !== print) lines.push(`  migration: ~ ${key} (edited)`)
  for (const key of Object.keys(old)) if (!(key in next.migrations)) lines.push(`  migration: - ${key}`)
  lines.push(...schemaChanges("schema", previous?.schema ?? [], next.schema))
  lines.push(...schemaChanges("baseline schema", baseline.before, baseline.after))
  return lines
}
