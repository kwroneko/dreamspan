// A single bounded fact snapshot per read-only connection. SQLite's connection-local
// data_version is read inside the operation's read transaction, before consulting it.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

const snapshots = new WeakMap<SqlClient.SqlClient, { key: string; scope: string; schema: number; data: unknown }>()
export const snapshotCache = <A>(sql: SqlClient.SqlClient, position: string, scope = position) =>
  Effect.gen(function* () {
    // Reading schema first establishes this read transaction's snapshot, including its data_version.
    yield* sql`SELECT rootpage FROM sqlite_schema LIMIT 1`
    const [data] = yield* sql<{ data_version: number }>`PRAGMA data_version`
    const [schema] = yield* sql<{ schema_version: number }>`PRAGMA schema_version`
    const key = JSON.stringify([position, data!.data_version, schema!.schema_version])
    const previous = snapshots.get(sql)
    return {
      hit: previous?.key === key ? (previous.data as A) : undefined,
      previous:
        previous?.scope === scope && previous.schema === schema!.schema_version ? (previous.data as A) : undefined,
      save: (value: A, characters: number) => {
        // Replace, never accumulate per-branch entries; oversized snapshots are not retained.
        if (characters <= 16_000_000) snapshots.set(sql, { key, scope, schema: schema!.schema_version, data: value })
        else snapshots.delete(sql)
      }
    }
  })
