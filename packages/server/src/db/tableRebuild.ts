// Table rebuilds for migrations (ARCHITECTURE.md §3.7 "Table rebuilds"). SQLite can't change a
// column's type, NOT NULL, CHECK, foreign key or delete rule in place: the table is made anew,
// its rows copied, the old one dropped and the new one renamed into place. With foreign keys on,
// that DROP TABLE first deletes every row, which cascades into every table pointing at it (all of
// a chat's messages, for `chats`), and `PRAGMA foreign_keys` is ignored inside a transaction. So a
// rebuild runs only in a migration marked `outsideTransaction` (migrations.ts): the runner turns
// foreign keys off before its own transaction, runs these steps in it, checks every reference
// with `PRAGMA foreign_key_check` before committing, and turns them back on.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export interface TableRebuild {
  /** The table to rebuild. */
  readonly table: string
  /** Its new `CREATE TABLE` statement, under the table's own name. */
  readonly create: string
  /**
   * What each new column is copied from: an SQL expression over the old row's columns. A new
   * column not named here takes the old column of the same name, or its default when the old
   * table had none. An old column the new table lacks is dropped.
   */
  readonly columns?: Readonly<Record<string, string>>
  /**
   * The table's own indexes and triggers are dropped with it and made again from their saved SQL.
   * Name one here to make it from new SQL instead, or `null` to leave it out (new ones go in a
   * statement step after the rebuild).
   */
  readonly objects?: Readonly<Record<string, string | null>>
  /**
   * Statements that fill a full-text index reading this table again, by the index's name. The
   * copy keeps every row's rowid, so an index whose rowid and indexed columns are copied unchanged
   * stays valid and needs none. One whose rowid or indexed columns change does, or the rebuild is
   * refused: the right filling depends on the index (`versions_fts` leaves out generating replies).
   */
  readonly refill?: Readonly<Record<string, ReadonlyArray<string>>>
}

/** A step of a migration that runs outside the migrator's transaction: SQL, or a table rebuild. */
export type OutsideStep = string | TableRebuild

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Column {
  readonly name: string
  readonly type: string
  readonly pk: number
  readonly hidden: number
}

/**
 * Rebuilds one table. Runs inside the caller's transaction, with foreign keys off: the runner in
 * migrations.ts makes sure of both, and checks every reference before it commits.
 */
export const rebuildTable = (rebuild: TableRebuild) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { table } = rebuild
    const fail = (message: string) => Effect.die(new Error(`Rebuilding ${table}: ${message}`))
    const [kind] = yield* sql<{ type: string }>`SELECT type FROM sqlite_master WHERE name = ${table}`
    if (kind?.type !== "table") return yield* fail("there is no such table")
    const header = /^\s*CREATE\s+TABLE\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\(/i.exec(rebuild.create)
    if (header?.[2] !== table) return yield* fail("the new CREATE TABLE statement must name the table itself")

    // What the drop takes with it: the table's own indexes and triggers (not the automatic indexes
    // of its keys, which come back with the new table). Views and other tables' triggers that read
    // it are kept as they are: the rename below leaves their text alone, and they find the new
    // table under the same name.
    const saved = yield* sql<{ type: string; name: string; sql: string }>`SELECT type, name, sql FROM sqlite_master
      WHERE tbl_name = ${table} AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY rowid`
    const savedNames = new Set(saved.map((object) => object.name))
    const unknownObjects = Object.keys(rebuild.objects ?? {}).filter((name) => !savedNames.has(name))
    if (unknownObjects.length > 0) return yield* fail(`it has no index or trigger ${unknownObjects.join(", ")}`)

    const columnsOf = (name: string) =>
      sql<Column>`SELECT name, type, pk, hidden FROM pragma_table_xinfo(${name})`.pipe(
        // Generated columns can't be written; the new table computes its own.
        Effect.map((columns) => columns.filter((column) => column.hidden === 0))
      )
    const before = yield* columnsOf(table)
    const temporary = `${table}__rebuild`
    yield* sql.unsafe(
      rebuild.create.slice(0, header.index) +
        `CREATE TABLE ${quote(temporary)} (` +
        rebuild.create.slice(header[0].length)
    )
    const after = yield* columnsOf(temporary)
    const oldNames = new Set(before.map((column) => column.name))
    const newNames = new Set(after.map((column) => column.name))
    const unknownColumns = Object.keys(rebuild.columns ?? {}).filter((name) => !newNames.has(name))
    if (unknownColumns.length > 0) return yield* fail(`the new table has no column ${unknownColumns.join(", ")}`)
    const copied = after.flatMap((column) => {
      const expression = rebuild.columns?.[column.name]
      if (expression !== undefined) return [{ name: column.name, expression }]
      return oldNames.has(column.name) ? [{ name: column.name, expression: quote(column.name) }] : []
    })

    // Full-text indexes that read this table (external content): which of them the copy keeps valid.
    const fts = yield* sql<{ name: string; sql: string }>`SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%USING fts5%'`
    const readers = fts.flatMap((index) => {
      const options = index.sql.slice(index.sql.indexOf("(") + 1, index.sql.lastIndexOf(")"))
      const option = (key: string) => new RegExp(`\\b${key}\\s*=\\s*['"]?([A-Za-z0-9_]+)`, "i").exec(options)?.[1]
      if (option("content") !== table) return []
      const columns = options
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
      return [{ name: index.name, rowid: option("content_rowid") ?? "rowid", columns }]
    })
    const unchanged = (name: string) =>
      newNames.has(name) && oldNames.has(name) && (rebuild.columns?.[name] ?? quote(name)) === quote(name)
    for (const reader of readers) {
      const kept = [reader.rowid, ...reader.columns].every((name) => name === "rowid" || unchanged(name))
      if (!kept && rebuild.refill?.[reader.name] === undefined)
        return yield* fail(`the full-text index ${reader.name} reads columns that change: give its refill statements`)
    }
    const unknownRefills = Object.keys(rebuild.refill ?? {}).filter(
      (name) => !readers.some((reader) => reader.name === name)
    )
    if (unknownRefills.length > 0) return yield* fail(`no full-text index ${unknownRefills.join(", ")} reads it`)

    // Rowids stay as they were, so external-content indexes keyed by them stay valid. A table whose
    // key is an INTEGER PRIMARY KEY keeps them through that column; one without is given them.
    const [shape] = yield* sql<{ wr: number }>`SELECT wr FROM pragma_table_list WHERE name = ${table}`
    const [newShape] = yield* sql<{ wr: number }>`SELECT wr FROM pragma_table_list WHERE name = ${temporary}`
    const rowidAlias = (columns: ReadonlyArray<Column>) =>
      columns.filter((column) => column.pk > 0).length === 1 &&
      columns.find((column) => column.pk > 0)!.type.toUpperCase() === "INTEGER"
    const keepRowid = shape!.wr === 0 && newShape!.wr === 0 && !rowidAlias(after)
    const targets = [...(keepRowid ? ["rowid"] : []), ...copied.map((column) => quote(column.name))]
    const sources = [...(keepRowid ? ["rowid"] : []), ...copied.map((column) => column.expression)]

    const count = (name: string) =>
      sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(name)}`.pipe(Effect.map(([row]) => row!.n))
    const rows = yield* count(table)
    yield* sql.unsafe(
      `INSERT INTO ${quote(temporary)} (${targets.join(", ")}) SELECT ${sources.join(", ")} FROM ${quote(table)}`
    )
    const copiedRows = yield* count(temporary)
    if (copiedRows !== rows) return yield* fail(`copied ${copiedRows} of its ${rows} rows`)

    // With foreign keys off this drops the table alone: no implicit delete, no cascades.
    yield* sql.unsafe(`DROP TABLE ${quote(table)}`)
    // The legacy rename moves the new table into place without parsing every view and trigger
    // that names the old one (they would fail to parse while it's gone) and without rewriting
    // them: they read the table by name, and find the new one.
    yield* sql.unsafe("PRAGMA legacy_alter_table = ON")
    yield* sql.unsafe(`ALTER TABLE ${quote(temporary)} RENAME TO ${quote(table)}`)
    yield* sql.unsafe("PRAGMA legacy_alter_table = OFF")
    for (const object of saved) {
      const replacement = rebuild.objects?.[object.name]
      if (replacement === null) continue
      yield* sql.unsafe(replacement ?? object.sql)
    }
    for (const statement of Object.values(rebuild.refill ?? {}).flat()) yield* sql.unsafe(statement)

    // Every view must still read: one that names a dropped column fails here, not at its first use.
    const views = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'view'`
    for (const view of views)
      yield* sql
        .unsafe(`SELECT * FROM ${quote(view.name)} LIMIT 0`)
        .pipe(Effect.catch((error) => fail(`the view ${view.name} no longer reads (${String(error)})`)))
  })
