import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Migrations run in the writer worker, before any reader connection is opened.
export const Migrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_users": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          handle TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
          created_at INTEGER NOT NULL,
          disabled_at INTEGER
        ) STRICT
      `
    })
  })
})
