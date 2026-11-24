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

/**
 * Bump when `rebuildTable` changes what it does to a table (how rows, rowids, saved objects or
 * full-text indexes are carried, what it checks), so the fingerprint of every released migration
 * with a rebuild step changes too (db/releases.ts `fingerprint`).
 */
export const TABLE_REBUILD_VERSION = 3

/** SQLite's own words for a failed statement: the deepest cause under the client's error and its reason. */
const reason = (error: unknown) => {
  let deepest = error
  while (deepest instanceof Error && deepest.cause !== undefined) deepest = deepest.cause
  return deepest instanceof Error ? deepest.message : String(deepest)
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

const unquote = (name: string) => {
  const first = name[0]
  if (first === "[") return name.slice(1, -1)
  return first === '"' || first === "'" || first === "`" ? name.slice(1, -1).replaceAll(first + first, first) : name
}

/** SQLite folds only ASCII letters in identifiers. */
const nameKey = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/** FTS5 arguments, split at commas outside quoted names, option values and comments. */
const ftsArguments = (create: string) => {
  const tokens =
    create
      .match(
        /"(?:[^"]|"")*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[^\s(),="'`\[/\-]+|[(),=/-]/g
      )
      ?.filter((token) => !token.startsWith("--") && !token.startsWith("/*")) ?? []
  const start = tokens.indexOf("(")
  if (start < 2 || nameKey(tokens[start - 2]!) !== "using" || nameKey(unquote(tokens[start - 1]!)) !== "fts5") return []
  const args: Array<Array<string>> = [[]]
  for (const token of tokens.slice(start + 1, tokens.lastIndexOf(")"))) {
    if (token === ",") args.push([])
    else args.at(-1)!.push(token)
  }
  return args
}

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
    const virtual = yield* sql<{ name: string; sql: string }>`SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`
    const contentNames = new Map(before.map(({ name }) => [nameKey(name), name]))
    const actualName = (name: string) => contentNames.get(nameKey(name)) ?? name
    const readers = virtual.flatMap((index) => {
      const options = new Map<string, string>()
      const columns: Array<string> = []
      for (const [name, next, value] of ftsArguments(index.sql)) {
        if (name === undefined) continue
        if (next === "=" && value !== undefined) options.set(nameKey(name), unquote(value))
        else if (next === undefined || nameKey(unquote(next)) !== "unindexed") columns.push(unquote(name))
      }
      // SQLite's names are case-insensitive, so `content=Version_Texts` reads version_texts.
      if (nameKey(options.get("content") ?? "") !== nameKey(table)) return []
      return [
        {
          name: index.name,
          rowid: actualName(options.get("content_rowid") ?? "rowid"),
          columns: columns.map(actualName)
        }
      ]
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
    // A full-text index left as it is stays right only if every row kept its rowid and the text it
    // indexes. The checks above read the statements; this reads the rows, so a rowid the copy
    // couldn't keep (a new INTEGER PRIMARY KEY, a key copied through an expression) is caught too.
    for (const reader of readers) {
      if (rebuild.refill?.[reader.name] !== undefined) continue
      const read = [reader.rowid, ...reader.columns]
        .map((name) => (name === "rowid" ? "rowid" : quote(name)))
        .join(", ")
      const [lost] = yield* sql.unsafe<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT ${read} FROM ${quote(table)} EXCEPT SELECT ${read} FROM ${quote(temporary)})`
      )
      if (lost!.n > 0)
        return yield* fail(
          `${lost!.n} rows would change their rowid or the text the full-text index ${reader.name} reads: give its refill statements`
        )
    }

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
        .pipe(Effect.catch((error) => fail(`the view ${view.name} no longer reads (${reason(error)})`)))
    // And every trigger must still compile, on any table: SQLite resolves a trigger's columns only
    // when a statement that fires it is prepared, so one naming a dropped column would otherwise
    // fail at its first use (inside a delete, say). EXPLAIN prepares a statement, with every
    // trigger it fires, and runs none of it.
    yield* compileTriggers(fail)
  })

/** The event a trigger fires on, from its statement. */
const triggerEvent = (create: string) => {
  // Read past the trigger name as one token, including SQLite's quoted identifier forms.
  const tokens = create.matchAll(
    /--[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"]|"")*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|\[[^\]]*\]|[\w$\u0080-\uffff]+|\S/g
  )
  const next = () => {
    for (const [token] of tokens) {
      if (!token.startsWith("--") && !token.startsWith("/*")) return token.toUpperCase()
    }
    return undefined
  }
  if (next() !== "CREATE") return undefined
  let token = next()
  if (token === "TEMP" || token === "TEMPORARY") token = next()
  if (token !== "TRIGGER") return undefined
  if (next() === "IF" && (next() !== "NOT" || next() !== "EXISTS" || next() === undefined)) return undefined
  token = next()
  if (token === ".") {
    next() // Schema-qualified trigger name.
    token = next()
  }
  if (token === "INSTEAD" && next() !== "OF") return undefined
  if (token === "BEFORE" || token === "AFTER" || token === "INSTEAD") token = next()
  return token === "INSERT" || token === "UPDATE" || token === "DELETE" ? token : undefined
}

/**
 * Prepares, without running, the statements that fire each trigger (an insert, an update of every
 * column, a delete on its table or view), which compiles every trigger in the database. Fails
 * with the first that names something that isn't there.
 */
const compileTriggers = (fail: (message: string) => Effect.Effect<never>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const triggers = yield* sql<{ name: string; tbl_name: string; sql: string }>`SELECT name, tbl_name, sql
      FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name`
    const owners = new Map<string, Map<string, Array<string>>>()
    for (const trigger of triggers) {
      const events = owners.get(trigger.tbl_name) ?? new Map<string, Array<string>>()
      owners.set(trigger.tbl_name, events)
      const event = triggerEvent(trigger.sql)
      if (event === undefined) return yield* fail(`the trigger ${trigger.name}'s event could not be read`)
      events.set(event, [...(events.get(event) ?? []), trigger.name])
    }
    for (const [owner, events] of owners) {
      const name = quote(owner)
      // Generated columns can't be set; a view's columns all can (through its INSTEAD OF triggers).
      const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_xinfo(${owner}) WHERE hidden = 0`
      const statements: Record<string, string> = {
        INSERT: `INSERT INTO ${name} DEFAULT VALUES`,
        UPDATE: `UPDATE ${name} SET ${columns.map((column) => `${quote(column.name)} = ${quote(column.name)}`).join(", ")}`,
        DELETE: `DELETE FROM ${name}`
      }
      for (const [event, names] of events)
        yield* sql
          .unsafe(`EXPLAIN ${statements[event]!}`)
          .pipe(
            Effect.catch((error) =>
              fail(`the trigger ${names.join(" or ")} on ${owner} no longer compiles (${reason(error)})`)
            )
          )
    }
  })
