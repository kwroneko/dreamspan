import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { bin, dataModel, draftHistory, users } from "./schema/index.ts"

/** node:sqlite prepares one statement at a time, so DDL is kept as a list of statements. */
const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

// Migrations run in the writer worker, before any reader connection is opened.
// Until the first release, the schema can still be reshaped freely here.
export const Migrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_users": runAll(users),
    "0002_data_model": runAll(dataModel),
    "0003_draft_history": runAll(draftHistory),
    "0004_recycle_bin": runAll(bin)
  })
})
