// Recorded releases (test/fixtures/releases, ARCHITECTURE.md §3.7 "Released schemas"): a migration a
// release ran never changes, a fresh install of a release's migrations makes exactly the schema it
// recorded, and a database at any release upgrades to the schema a fresh install of today's makes.
// Recording again: `npm run schema:record` (scripts/record-release-schema.ts).
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { writerConnection } from "../src/db/connection.ts"
import { migrate, migrationDefinitions, type MigrationDefinition } from "../src/db/migrations.ts"
import { fingerprint, readReleases, readSchema, releasedMigrationProblems, type Release } from "../src/db/releases.ts"
import { tempDir } from "./support/tempDir.ts"

const releases = readReleases()

const layer = () => writerConnection(join(tempDir("release"), "db.sqlite"))

const definitionsOf = (release: Release): Readonly<Record<string, MigrationDefinition>> =>
  Object.fromEntries(
    Object.keys(release.migrations).map((key) => [
      key,
      (migrationDefinitions as Readonly<Record<string, MigrationDefinition>>)[key]!
    ])
  )

describe("released schemas", () => {
  it("records release 0 at least, one file per release, numbered in order", () => {
    assert.isAbove(releases.length, 0)
    assert.deepStrictEqual(
      releases.map((release) => release.release),
      releases.map((_, i) => i)
    )
    // Only the newest release can still be provisional: an older one was followed by real use.
    assert.isTrue(releases.slice(0, -1).every((release) => !release.provisional))
  })

  it("never changes a migration a recorded release ran", () => {
    const problems = releasedMigrationProblems(migrationDefinitions, releases)
    assert.deepStrictEqual(problems, [], problems.join("\n"))
  })

  for (const release of releases)
    it.effect(`makes exactly release ${release.release}'s recorded schema on a fresh install of its migrations`, () =>
      Effect.gen(function* () {
        yield* migrate(definitionsOf(release))
        assert.deepStrictEqual(yield* readSchema, release.schema)
      }).pipe(Effect.provide(layer()))
    )

  for (const release of releases)
    it.effect(`upgrades a database at release ${release.release} to a fresh install's schema`, () =>
      Effect.gen(function* () {
        // A fresh install of today's migrations, in a database of its own.
        const fresh = yield* migrate(migrationDefinitions).pipe(Effect.andThen(readSchema), Effect.provide(layer()))
        yield* migrate(definitionsOf(release))
        yield* migrate(migrationDefinitions)
        assert.deepStrictEqual(yield* readSchema, fresh)
      }).pipe(Effect.provide(layer()))
    )
})

describe("the released-migration check", () => {
  const statements = (...sql: Array<string>): MigrationDefinition => ({ statements: sql })
  const definitions = {
    "0001_baseline": statements("CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT"),
    "0002_more": statements("CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT")
  }
  const release = (provisional: boolean, defs: Readonly<Record<string, MigrationDefinition>>): Release => ({
    release: 0,
    provisional,
    migrations: Object.fromEntries(Object.entries(defs).map(([key, definition]) => [key, fingerprint(definition)])),
    schema: []
  })

  it("passes unchanged and added migrations", () => {
    assert.deepStrictEqual(releasedMigrationProblems(definitions, [release(false, definitions)]), [])
    assert.deepStrictEqual(
      releasedMigrationProblems({ ...definitions, "0003_new": statements("SELECT 1") }, [release(false, definitions)]),
      []
    )
  })

  it("catches an edit, a removal, a rename and a migration numbered below the release's last", () => {
    const released = [release(false, definitions)]
    const edited = releasedMigrationProblems(
      { ...definitions, "0001_baseline": statements("CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT) STRICT") },
      released
    )
    assert.deepStrictEqual(edited, [
      "Migration 0001_baseline, which release 0 ran, was edited. Release 0 is in use: put the change in a new migration instead."
    ])
    const renamed = releasedMigrationProblems(
      { "0001_baseline": definitions["0001_baseline"], "0002_renamed": definitions["0002_more"] },
      released
    )
    assert.strictEqual(renamed.length, 2)
    assert.include(renamed[0], "0002_more, which release 0 ran, is gone or renamed")
    assert.include(renamed[1], "0002_renamed is new since release 0 but numbered at or below its last one")
    // The same check reads an edit to the statements a migration imports (the baseline's helpers).
    const outside = releasedMigrationProblems(
      { ...definitions, "0002_more": { outsideTransaction: ["CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT"] } },
      released
    )
    assert.include(outside[0], "0002_more, which release 0 ran, was edited")
  })

  it("says how to record a provisional release again", () => {
    const [problem] = releasedMigrationProblems({ ...definitions, "0002_more": statements("SELECT 2") }, [
      release(true, definitions)
    ])
    assert.include(problem, "npm run schema:record")
  })
})
