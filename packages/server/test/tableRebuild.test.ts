// Table rebuilds in migrations (db/tableRebuild.ts, the `outsideTransaction` runner in
// db/migrations.ts) on a synthetic owner-shaped library: every row of every table survives, the
// rebuilt table's indexes and triggers come back, full-text search keeps working, and a rebuild
// that would break a reference is refused with nothing changed.
import { createHash } from "node:crypto"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { migrate, migrationDefinitions, type MigrationDefinition } from "../src/db/migrations.ts"
import type { OutsideStep, TableRebuild } from "../src/db/tableRebuild.ts"
import { writeRebuildFixture, type RebuildShape } from "./support/rebuildFixture.ts"
import { slowIt } from "./support/slow.ts"
import { tempDir } from "./support/tempDir.ts"

const layer = () => writerConnection(join(tempDir("rebuild"), "db.sqlite"))

const newest = Math.max(...Object.keys(migrationDefinitions).map((key) => Number(key.slice(0, 4))))
const nextKey = (name: string, offset = 1) => `${String(newest + offset).padStart(4, "0")}_${name}`
const withSteps = (
  steps: ReadonlyArray<OutsideStep>,
  more: Readonly<Record<string, MigrationDefinition>> = {}
): Readonly<Record<string, MigrationDefinition>> => ({
  ...migrationDefinitions,
  [nextKey("rebuild")]: { outsideTransaction: steps },
  ...more
})

/** A digest of every row of every ordinary table but `except` and the migration ledger, by table. */
const digests = (except: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    const out: Record<string, { rows: number; digest: string }> = {}
    for (const { name } of tables) {
      if (except.includes(name) || name === "effect_sql_migrations") continue
      const rows = (yield* sql.unsafe(`SELECT * FROM "${name}"`)).map((row) => JSON.stringify(row)).sort()
      out[name] = { rows: rows.length, digest: createHash("sha256").update(rows.join("\n")).digest("hex") }
    }
    return out
  })

const schemaRows = (except: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ type: string; name: string; sql: string }>`SELECT type, name, sql FROM sqlite_master
      WHERE name <> ${except} AND sql IS NOT NULL ORDER BY type, name`
  })

const createSqlOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE name = ${table}`
    return row!.sql
  })

/** The table's statement with one more column, before its closing `) STRICT`. */
const addColumn = (create: string, column: string) => {
  const at = create.lastIndexOf(")")
  return `${create.slice(0, at).trimEnd()},\n    ${column}\n  ${create.slice(at)}`
}

const pragma = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql.unsafe(`PRAGMA ${name}`)
    return Object.values(row!)[0]
  })

const search = (word: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return (yield* sql<{
      rowid: number
    }>`SELECT rowid FROM versions_fts WHERE versions_fts MATCH ${word} ORDER BY rowid`).map((row) => row.rowid)
  })

const fast: RebuildShape = { chats: 6, long: 600, short: 40, branches: 60, branchLength: 8, maxSwipes: 20 }
// The owner's shape (hundreds of branches, thousands of messages, 20 to 50 swipes).
const owner: RebuildShape = { chats: 12, long: 3000, short: 80, branches: 300, branchLength: 10, maxSwipes: 50 }

const rebuildsChats = (shape: RebuildShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(migrationDefinitions)
    yield* writeRebuildFixture(shape)
    const before = yield* digests(["chats"])
    const schemaBefore = yield* schemaRows("chats")
    const chatsBefore = yield* sql`SELECT * FROM chats ORDER BY id`
    const lanternBefore = yield* search("lantern")
    const create = addColumn(yield* createSqlOf("chats"), "archive_note TEXT NOT NULL DEFAULT ''")
    const started = performance.now()
    // The title copied through an expression, the new column from its default.
    yield* migrate(withSteps([{ table: "chats", create, columns: { title: "upper(title)" } }]))
    const ms = performance.now() - started
    console.log(
      "REBUILD chats",
      JSON.stringify({ slots: before.slots!.rows, versions: before.versions!.rows, ms: Math.round(ms) })
    )

    // Every other table, row for row (the SET NULL references from the usage ledger included).
    assert.deepStrictEqual(yield* digests(["chats"]), before)
    assert.isAbove(before.slots!.rows, shape.long)
    assert.isAbove(before.llm_requests!.rows, 0)
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM llm_requests WHERE chat_id IS NULL`)[0]!.n,
      0
    )
    // The chats themselves, with their old columns as they were and the title through its expression.
    // Not the query text read before: node:sqlite keeps a prepared `SELECT *`'s old column list
    // across a schema change, and the client caches statements by their text.
    const chatsAfter = yield* sql<Record<string, unknown>>`SELECT * FROM chats AS rebuilt ORDER BY id`
    assert.deepStrictEqual(
      chatsAfter.map(({ archive_note, title, ...rest }) => ({
        ...rest,
        title: String(title).toLowerCase(),
        archive_note
      })),
      chatsBefore.map((row) => ({ ...row, title: String(row.title).toLowerCase(), archive_note: "" }))
    )
    assert.isTrue(chatsAfter.every((row) => String(row.title) === String(row.title).toUpperCase()))
    // Its indexes, triggers and every view and other object as they were; the table under its name.
    assert.deepStrictEqual(yield* schemaRows("chats"), schemaBefore)
    assert.include(yield* createSqlOf("chats"), "archive_note")
    assert.deepStrictEqual(yield* search("lantern"), lanternBefore)
    assert.strictEqual(yield* pragma("foreign_keys"), 1)
    assert.strictEqual(yield* pragma("legacy_alter_table"), 0)
    assert.strictEqual(yield* pragma("integrity_check"), "ok")
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])
    assert.deepStrictEqual(
      (yield* sql<{ name: string }>`SELECT name FROM effect_sql_migrations WHERE migration_id = ${newest + 1}`).map(
        (row) => row.name
      ),
      ["rebuild"]
    )

    // The triggers act on the new table: a new chat gets its first fork, and the foreign keys
    // (on again) point at it, so deleting a chat cascades to its messages and nowhere else.
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('fresh', 'u', 'rp', 'active', 9)`
    assert.deepStrictEqual(
      (yield* sql`SELECT id FROM forks WHERE chat_id = 'fresh'`).map((row) => row.id),
      ["fresh"]
    )
    const others = (yield* sql<{ n: number }>`SELECT count(*) AS n FROM slots WHERE chat_id <> 'chat1'`)[0]!.n
    yield* sql`DELETE FROM chats WHERE id = 'chat1'`
    assert.strictEqual((yield* sql<{ n: number }>`SELECT count(*) AS n FROM slots WHERE chat_id = 'chat1'`)[0]!.n, 0)
    assert.strictEqual((yield* sql<{ n: number }>`SELECT count(*) AS n FROM slots`)[0]!.n, others)

    // Recorded: the next start runs nothing.
    yield* migrate(withSteps([{ table: "chats", create, columns: { title: "upper(title)" } }]))
    assert.include(yield* createSqlOf("chats"), "archive_note")
  })

const rebuildsVersionTexts = (shape: RebuildShape) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(migrationDefinitions)
    yield* writeRebuildFixture(shape)
    const before = yield* digests(["version_texts"])
    const textsBefore = yield* sql`SELECT * FROM version_texts ORDER BY version_seq`
    const words = ["lantern", "harbor", "glacier", "flickers"]
    const found = yield* Effect.forEach(words, search)
    assert.isAbove(found[0]!.length, 100)
    // The reply still generating isn't indexed, and stays so.
    assert.deepStrictEqual(found[3], [])
    const create = addColumn(yield* createSqlOf("version_texts"), "note TEXT")
    const started = performance.now()
    yield* migrate(withSteps([{ table: "version_texts", create }]))
    console.log(
      "REBUILD version_texts",
      JSON.stringify({ rows: textsBefore.length, ms: Math.round(performance.now() - started) })
    )

    // The index is kept as it was (its shadow tables are in `before`), and still matches.
    assert.deepStrictEqual(yield* digests(["version_texts"]), before)
    assert.deepStrictEqual(
      (yield* sql<Record<string, unknown>>`SELECT * FROM version_texts AS rebuilt ORDER BY version_seq`).map(
        ({ note, ...rest }) => {
          assert.isNull(note)
          return rest
        }
      ),
      textsBefore
    )
    assert.deepStrictEqual(yield* Effect.forEach(words, search), found)
    assert.strictEqual(yield* pragma("integrity_check"), "ok")
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])
    // The payload triggers are back: a finished reply is indexed; an amended human turn keeps history.
    const streaming = (yield* sql<{ seq: number }>`SELECT seq FROM versions WHERE id = 'chat0-m1-streaming'`)[0]!.seq
    yield* sql`UPDATE version_records SET status = 'complete' WHERE id = 'chat0-m1-streaming'`
    assert.include(yield* search("flickers"), streaming)
    const history = (yield* sql<{ n: number }>`SELECT count(*) AS n FROM version_history`)[0]!.n
    yield* sql`UPDATE version_records SET content = 'The traveler asks about the quarry, amended.' WHERE id = 'chat0-m0-v0'`
    assert.strictEqual((yield* sql<{ n: number }>`SELECT count(*) AS n FROM version_history`)[0]!.n, history + 1)
    // Deleting a version still takes its payload with it.
    const texts = (yield* sql<{ n: number }>`SELECT count(*) AS n FROM version_texts`)[0]!.n
    yield* sql`DELETE FROM chats WHERE id = 'chat2'`
    assert.isBelow((yield* sql<{ n: number }>`SELECT count(*) AS n FROM version_texts`)[0]!.n, texts)
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])
  })

describe("table rebuilds", () => {
  it.effect("rebuild chats with a new column, keeping every row of every table that points at it", () =>
    rebuildsChats(fast).pipe(Effect.provide(layer()))
  )
  slowIt.effect("rebuild chats at the owner's scale", () => rebuildsChats(owner).pipe(Effect.provide(layer())), 600_000)

  it.effect("rebuild version_texts, keeping its full-text index and every version", () =>
    rebuildsVersionTexts(fast).pipe(Effect.provide(layer()))
  )
  slowIt.effect(
    "rebuild version_texts at the owner's scale",
    () => rebuildsVersionTexts(owner).pipe(Effect.provide(layer())),
    600_000
  )

  it.effect("refill a full-text index whose column changes, and refuse to rebuild without the refill", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(migrationDefinitions)
      yield* writeRebuildFixture({ ...fast, long: 120, branches: 10 })
      const create = yield* createSqlOf("version_texts")
      const columns = { content: "replace(content, 'lantern', 'torch')" }
      const refused = yield* Effect.exit(migrate(withSteps([{ table: "version_texts", create, columns }])))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(refused), "versions_fts reads columns that change")
      assert.isAbove((yield* search("lantern")).length, 0)
      assert.strictEqual(yield* pragma("foreign_keys"), 1)

      const torches = (yield* sql<{ version_seq: number }>`SELECT t.version_seq FROM version_texts t
          JOIN versions v ON v.seq = t.version_seq WHERE t.content LIKE '%lantern%' AND v.status <> 'generating'
          ORDER BY t.version_seq`).map((row) => row.version_seq)
      yield* migrate(
        withSteps([
          {
            table: "version_texts",
            create,
            columns,
            refill: {
              versions_fts: [
                `INSERT INTO versions_fts(versions_fts) VALUES ('delete-all')`,
                `INSERT INTO versions_fts(rowid, content) SELECT t.version_seq, t.content FROM version_texts t
                  JOIN versions v ON v.seq = t.version_seq WHERE v.status <> 'generating'`
              ]
            }
          }
        ])
      )
      assert.deepStrictEqual(yield* search("lantern"), [])
      assert.deepStrictEqual(yield* search("torch"), torches)
      assert.strictEqual(yield* pragma("integrity_check"), "ok")
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuse a rebuild that would break a reference, changing nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(migrationDefinitions)
      yield* writeRebuildFixture({ ...fast, long: 120, branches: 10 })
      const before = yield* digests()
      const schema = yield* schemaRows("")
      const create = yield* createSqlOf("chats")
      const exit = yield* Effect.exit(
        migrate(withSteps([{ table: "chats", create, columns: { owner_user_id: "'nobody'" } }]))
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "would leave")
      assert.include(String(exit), "pointing at rows that don't exist")
      assert.include(String(exit), "in chats (pointing into users)")
      assert.notInclude(String(exit), "empty")
      assert.deepStrictEqual(yield* digests(), before)
      assert.deepStrictEqual(yield* schemaRows(""), schema)
      assert.strictEqual(yield* pragma("foreign_keys"), 1)
      assert.strictEqual(yield* pragma("legacy_alter_table"), 0)
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id > ${newest}`,
        []
      )
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuse to keep a full-text index whose rows would change rowid, its content table named in any case", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // A table keyed by text, so its rowids are its own, with gaps; the index names it `Notes`.
      const notes = {
        [nextKey("notes")]: {
          statements: [
            "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT",
            "CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='Notes', content_rowid='rowid')",
            "INSERT INTO notes (id, body) VALUES ('a', 'amber lantern'), ('b', 'blue harbor'), ('c', 'cold glacier'), ('d', 'dim lantern')",
            "DELETE FROM notes WHERE id IN ('a', 'c')",
            "INSERT INTO notes_fts (rowid, body) SELECT rowid, body FROM notes"
          ]
        }
      }
      yield* migrate({ ...migrationDefinitions, ...notes })
      const lanterns = (yield* sql<{ rowid: number }>`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'lantern'`).map(
        (row) => row.rowid
      )
      assert.deepStrictEqual(lanterns, [4])
      const rebuild = (step: Partial<TableRebuild>) => ({
        ...migrationDefinitions,
        ...notes,
        [nextKey("rebuild", 2)]: {
          outsideTransaction: [
            {
              table: "notes",
              create: "CREATE TABLE notes (n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL) STRICT",
              ...step
            }
          ]
        }
      })
      // A new INTEGER PRIMARY KEY numbers the rows afresh (1, 2): the index would point at the wrong ones.
      const renumbered = yield* Effect.exit(migrate(rebuild({})))
      assert.isTrue(Exit.isFailure(renumbered))
      assert.include(
        String(renumbered),
        "2 rows would change their rowid or the text the full-text index notes_fts reads"
      )
      // An indexed column that changes is seen through `content='Notes'` too.
      const changed = yield* Effect.exit(migrate(rebuild({ columns: { n: "rowid", body: "upper(body)" } })))
      assert.include(String(changed), "the full-text index notes_fts reads columns that change")
      assert.strictEqual(yield* pragma("foreign_keys"), 1)
      // Keyed by the old rowids, the index stays right as it is.
      yield* migrate(rebuild({ columns: { n: "rowid" } }))
      assert.deepStrictEqual(
        (yield* sql<{
          id: string
        }>`SELECT id FROM notes WHERE n IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'lantern')`).map(
          (row) => row.id
        ),
        ["d"]
      )
      assert.strictEqual(yield* pragma("integrity_check"), "ok")
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuse a rebuild that leaves another table's trigger naming a column it drops", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const setup = {
        [nextKey("notes")]: {
          statements: [
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0) STRICT",
            "CREATE TABLE note_reads (note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE) STRICT",
            // Only an update's SET names `seen`: SQLite's own rename check doesn't read that far.
            `CREATE TRIGGER note_reads_mark AFTER INSERT ON note_reads BEGIN
              UPDATE notes SET seen = 1 WHERE id = new.note_id;
            END`,
            "INSERT INTO notes (id, body) VALUES (1, 'a')"
          ]
        }
      }
      yield* migrate({ ...migrationDefinitions, ...setup })
      const schema = yield* schemaRows("")
      const exit = yield* Effect.exit(
        migrate({
          ...migrationDefinitions,
          ...setup,
          [nextKey("rebuild", 2)]: {
            outsideTransaction: [
              { table: "notes", create: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT" }
            ]
          }
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "the trigger note_reads_mark on note_reads no longer compiles")
      assert.include(String(exit), "seen")
      assert.deepStrictEqual(yield* schemaRows(""), schema)
      // Replaced in the same migration, the rebuild goes through, and the trigger works.
      yield* migrate({
        ...migrationDefinitions,
        ...setup,
        [nextKey("rebuild", 2)]: {
          outsideTransaction: [
            "DROP TRIGGER note_reads_mark",
            { table: "notes", create: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT" },
            `CREATE TRIGGER note_reads_mark AFTER INSERT ON note_reads BEGIN
              UPDATE notes SET body = body || '.' WHERE id = new.note_id;
            END`
          ]
        }
      })
      yield* sql`INSERT INTO note_reads (note_id) VALUES (1)`
      assert.deepStrictEqual(
        (yield* sql<{ body: string }>`SELECT body FROM notes`).map((row) => row.body),
        ["a."]
      )
    }).pipe(Effect.provide(layer()))
  )

  it.effect("keeps an unrelated view's insert-only trigger with a single-quoted name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(
        withSteps([
          "CREATE TABLE spare (id INTEGER PRIMARY KEY)",
          "CREATE TABLE notes (body TEXT)",
          "CREATE VIEW editable AS SELECT body FROM notes",
          "CREATE TRIGGER 'keep edit' INSTEAD OF INSERT ON editable BEGIN INSERT INTO notes VALUES (NEW.body); END",
          { table: "spare", create: "CREATE TABLE spare (id INTEGER PRIMARY KEY, label TEXT)" }
        ])
      )
      yield* sql`INSERT INTO editable VALUES ('made it')`
      assert.deepStrictEqual(yield* sql`SELECT body FROM notes`, [{ body: "made it" }])
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuse a rebuild that names what the table doesn't have", () =>
    Effect.gen(function* () {
      yield* migrate(migrationDefinitions)
      const create = yield* createSqlOf("chats")
      for (const [step, message] of [
        [{ table: "chats", create: create.replace("chats", "chatz") }, "must name the table itself"],
        [{ table: "chats", create, columns: { nope: "1" } }, "has no column nope"],
        [{ table: "chats", create, objects: { nope: null } }, "has no index or trigger nope"],
        [{ table: "chats", create, refill: { nope: [] } }, "no full-text index nope"],
        [{ table: "nope", create }, "no such table"]
      ] as const) {
        const exit = yield* Effect.exit(migrate(withSteps([step])))
        assert.isTrue(Exit.isFailure(exit))
        assert.include(String(exit), message)
      }
    }).pipe(Effect.provide(layer()))
  )

  it.effect("run between ordinary migrations, in order, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(migrationDefinitions)
      yield* writeRebuildFixture({ ...fast, chats: 2, long: 60, branches: 4 })
      // Replaces the chat index made by the baseline and adds one after the rebuild, in its transaction.
      const definitions = withSteps(
        [
          {
            table: "chats",
            create: yield* createSqlOf("chats"),
            objects: { chats_owner_live: null }
          },
          `CREATE INDEX chats_owner_created ON chats(owner_user_id, created_at)`
        ],
        { [nextKey("after", 2)]: { statements: [`CREATE TABLE after_rebuild (id INTEGER PRIMARY KEY) STRICT`] } }
      )
      const indexes = yield* sql<{
        name: string
      }>`SELECT name FROM sqlite_master WHERE tbl_name = 'chats' AND type = 'index' AND sql IS NOT NULL`
      assert.include(
        indexes.map((row) => row.name),
        "chats_owner_live"
      )
      yield* migrate(definitions)
      yield* migrate(definitions)
      const after = (yield* sql<{
        name: string
      }>`SELECT name FROM sqlite_master WHERE tbl_name = 'chats' AND type = 'index' AND sql IS NOT NULL`).map(
        (row) => row.name
      )
      assert.notInclude(after, "chats_owner_live")
      assert.include(after, "chats_owner_created")
      assert.deepStrictEqual(
        (yield* sql<{
          migration_id: number
        }>`SELECT migration_id FROM effect_sql_migrations WHERE migration_id > ${newest} ORDER BY 1`).map(
          (row) => row.migration_id
        ),
        [newest + 1, newest + 2]
      )
      assert.strictEqual((yield* sql<{ n: number }>`SELECT count(*) AS n FROM after_rebuild`)[0]!.n, 0)
    }).pipe(Effect.provide(layer()))
  )

  // Why the helper exists: in the migrator's transaction, turning foreign keys off does nothing, so
  // a DROP TABLE there first deletes every row and cascades through everything pointing at it.
  it.effect("can't turn foreign keys off inside the migrator's transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate({
        ...migrationDefinitions,
        [nextKey("naive")]: {
          statements: [
            "PRAGMA foreign_keys = OFF",
            "CREATE TABLE fk_state AS SELECT foreign_keys AS state FROM pragma_foreign_keys"
          ]
        }
      })
      assert.deepStrictEqual(
        (yield* sql<{ state: number }>`SELECT state FROM fk_state`).map((row) => row.state),
        [1]
      )
    }).pipe(Effect.provide(layer()))
  )
})
