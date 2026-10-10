import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { bin, dataModel, draftHistory, providers, users } from "./schema/index.ts"

/** node:sqlite prepares one statement at a time, so DDL is kept as a list of statements. */
const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

/** 0005 recreates connections and models, which is only safe while nothing has written them. */
const providersMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly n: number
  }>`SELECT (SELECT count(*) FROM connections) + (SELECT count(*) FROM models) AS n`
  if (rows[0]!.n > 0) return yield* Effect.die(new Error("0005_providers: connections or models already hold rows"))
  yield* runAll(providers)
})

// Migrations run in the writer worker, before any reader connection is opened.
// Until the first release, the schema can still be reshaped freely here.
export const migrations = {
  "0001_users": runAll(users),
  "0002_data_model": runAll(dataModel),
  "0003_draft_history": runAll(draftHistory),
  "0004_recycle_bin": runAll(bin),
  "0005_providers": providersMigration
}

export const Migrations = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) })
