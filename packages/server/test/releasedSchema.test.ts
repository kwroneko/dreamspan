// Recorded releases (test/fixtures/releases, ARCHITECTURE.md §3.7 "Released schemas"): a migration a
// release ran never changes, a fresh install of a release's migrations makes exactly the schema it
// recorded, and a database at any release upgrades to the schema a fresh install of today's makes.
// Recording again: `npm run schema:record` (scripts/record-release-schema.ts).
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { migrate, migrationDefinitions, type MigrationDefinition } from "../src/db/migrations.ts"
import {
  fingerprint,
  fingerprintSource,
  readReleases,
  readSchema,
  recordingRefusal,
  releaseChanges,
  releasedMigrationProblems,
  stableJson,
  type Release
} from "../src/db/releases.ts"
import { TABLE_REBUILD_VERSION } from "../src/db/tableRebuild.ts"
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

/** Every row of every ordinary table but the migration ledger, by table, sorted. */
const readData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'
    AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations' ORDER BY name`
  const data: Record<string, ReadonlyArray<string>> = {}
  for (const { name } of tables)
    data[name] = (yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`))
      .map((row) =>
        stableJson(
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              value instanceof Uint8Array ? `x'${Buffer.from(value).toString("hex")}'` : value
            ])
          )
        )
      )
      .sort()
  return data
})

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
        const fresh = yield* migrate(migrationDefinitions).pipe(
          Effect.andThen(Effect.all({ schema: readSchema, data: readData })),
          Effect.provide(layer())
        )
        yield* migrate(definitionsOf(release))
        yield* migrate(migrationDefinitions)
        assert.deepStrictEqual(yield* readSchema, fresh.schema)
        // And the rows the migrations seed: an upgrade must not leave out or change what a fresh install has.
        assert.deepStrictEqual(yield* readData, fresh.data)
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

  it("catches migrations that share a number, released or not", () => {
    const problems = releasedMigrationProblems(
      { ...definitions, "0003_a": statements("SELECT 3"), "0003_b": statements("SELECT 4") },
      [release(false, definitions)]
    )
    assert.deepStrictEqual(problems, [
      "Migrations 0003_a and 0003_b share a number: only one of them would ever run. Renumber the newer one."
    ])
    // Today's migrations have none.
    assert.isFalse(releasedMigrationProblems(migrationDefinitions, []).some((problem) => problem.includes("share")))
  })
})

describe("migration fingerprints", () => {
  const rebuild: MigrationDefinition = {
    outsideTransaction: [
      "SELECT 1",
      { table: "chats", create: "CREATE TABLE chats (id TEXT) STRICT", columns: { a: "1", b: "2" } }
    ]
  }

  it("name the code an outside-transaction migration runs, and its version", () => {
    const source = fingerprintSource(rebuild)
    assert.include(source, `"rebuildTable":${TABLE_REBUILD_VERSION}`)
    assert.include(source, `"runOutside":1`)
    assert.include(source, `"steps":["sql","rebuildTable(chats)"]`)
    // An ordinary migration is its statements alone, as recorded before the code was named.
    assert.strictEqual(fingerprintSource({ statements: ["SELECT 1"] }), JSON.stringify({ statements: ["SELECT 1"] }))
  })

  it("don't depend on key order, and refuse what JSON would drop or flatten", () => {
    const reordered: MigrationDefinition = {
      outsideTransaction: [
        "SELECT 1",
        { columns: { b: "2", a: "1" }, create: "CREATE TABLE chats (id TEXT) STRICT", table: "chats" }
      ]
    }
    assert.strictEqual(fingerprint(reordered), fingerprint(rebuild))
    for (const [value, kind] of [
      [undefined, "undefined"],
      [new Set(["a"]), "Set"],
      [new Map([["a", "b"]]), "Map"],
      [/a/, "RegExp"],
      [() => 1, "function"]
    ] as const) {
      const odd = {
        outsideTransaction: [{ table: "chats", create: "", objects: value }]
      } as unknown as MigrationDefinition
      assert.throws(() => fingerprint(odd), new RegExp(`definition.outsideTransaction\\[0\\].objects is a ${kind}`))
    }
    assert.throws(() => stableJson({ a: Number.NaN }), "definition.a is NaN")
  })
})

describe("recording a release", () => {
  const statements = (...sql: Array<string>): MigrationDefinition => ({ statements: sql })
  const definitions = { "0001_baseline": statements("CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT") }
  const release = (
    number: number,
    provisional: boolean,
    defs: Readonly<Record<string, MigrationDefinition>>
  ): Release => ({
    release: number,
    provisional,
    migrations: Object.fromEntries(Object.entries(defs).map(([key, definition]) => [key, fingerprint(definition)])),
    schema: []
  })
  const more = { ...definitions, "0002_more": statements("CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT") }

  it("adds a release only after the newest is final, with its migrations unchanged and new ones above them", () => {
    assert.include(recordingRefusal("new", more, [release(0, true, definitions)]), "still provisional")
    assert.include(recordingRefusal("new", more, [release(0, true, definitions)]), "-- --final first")
    assert.include(recordingRefusal("new", more, []), "No release is recorded yet")
    assert.include(recordingRefusal("new", definitions, [release(0, false, definitions)]), "nothing to record")
    const edited = { ...more, "0001_baseline": statements("CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT) STRICT") }
    assert.include(
      recordingRefusal("new", edited, [release(0, false, definitions)]),
      "0001_baseline, which release 0 ran, was edited"
    )
    const below = { ...more, "0001_other": statements("SELECT 1") }
    assert.include(recordingRefusal("new", below, [release(0, false, more)]), "share a number")
    assert.isUndefined(recordingRefusal("new", more, [release(0, false, definitions)]))
  })

  it("records the newest again only while it is provisional, and never with numbers shared", () => {
    assert.isUndefined(recordingRefusal("again", more, [release(0, true, definitions)]))
    assert.isUndefined(recordingRefusal("final", more, [release(0, true, definitions)]))
    assert.isUndefined(recordingRefusal("again", more, []))
    assert.include(
      recordingRefusal("again", more, [release(0, false, definitions)]),
      "is in use and is never recorded again"
    )
    assert.include(recordingRefusal("final", more, [release(0, false, definitions)]), "is in use")
    assert.include(recordingRefusal("again", { ...more, "0002_twin": statements("SELECT 1") }, []), "share a number")
  })

  it("lists what a recording changes", () => {
    const entry = (name: string, sql: string) => ({ type: "table", name, tbl_name: name, sql })
    const before = { ...release(0, true, definitions), schema: [entry("a", "CREATE TABLE a (id)"), entry("gone", "x")] }
    const after = {
      ...release(0, false, { "0001_baseline": statements("SELECT 9"), "0002_more": statements("SELECT 1") }),
      schema: [entry("a", "CREATE TABLE a (id, x)"), entry("b", "CREATE TABLE b (id)")]
    }
    assert.deepStrictEqual(releaseChanges(before, after, { before: [entry("a", "1")], after: [entry("a", "1")] }), [
      "  release 0: in use from now on (final)",
      "  migration: ~ 0001_baseline (edited)",
      "  migration: + 0002_more",
      "  schema: + table b",
      "  schema: - table gone",
      "  schema: ~ table a"
    ])
    assert.deepStrictEqual(releaseChanges(before, before, { before: [], after: [] }), [])
    assert.deepStrictEqual(
      releaseChanges(undefined, { ...before, schema: [] }, { before: [], after: [entry("a", "1")] }),
      ["  release 0: new file", "  migration: + 0001_baseline", "  baseline schema: + table a"]
    )
  })
})
