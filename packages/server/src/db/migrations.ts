import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import {
  accounts,
  bin,
  binIndex,
  credentials,
  dataModel,
  draftHistory,
  graphIntegrity,
  providers,
  secretBindings,
  users
} from "./schema/index.ts"

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

/** 0006 retires per-connection keys, which is only safe while no connection holds one. */
const credentialsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM connections WHERE api_key_enc IS NOT NULL`
  if (rows[0]!.n > 0) {
    return yield* Effect.die(
      new Error("0006_credentials: connections still hold keys; remove them and enter them again")
    )
  }
  yield* runAll(credentials)
})

// Migrations run in the writer worker, before any reader connection is opened.
// Until the first release, the schema can still be reshaped freely here.
export const migrations = {
  "0001_users": runAll(users),
  "0002_data_model": runAll(dataModel),
  "0003_draft_history": runAll(draftHistory),
  "0004_recycle_bin": runAll(bin),
  "0005_providers": providersMigration,
  "0006_credentials": credentialsMigration,
  "0007_accounts": runAll(accounts),
  "0008_secret_bindings": runAll(secretBindings),
  "0009_bin_index": runAll(binIndex),
  "0010_graph_integrity": runAll(graphIntegrity)
}

export const Migrations = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) })
