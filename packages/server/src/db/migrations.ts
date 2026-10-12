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
  draftSessions,
  graphIntegrity,
  inspector,
  ownership,
  providers,
  queue,
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
  "0010_graph_integrity": runAll(graphIntegrity),
  "0011_ownership": runAll(ownership),
  "0012_queued_messages": runAll(queue),
  "0013_draft_sessions": runAll(draftSessions),
  "0014_deleted_subtree_roots": runAll([
    `ALTER TABLE slots ADD COLUMN branch_deleted INTEGER NOT NULL DEFAULT 0 CHECK (branch_deleted IN (0, 1))`,
    `UPDATE slots SET branch_deleted = 1 WHERE id IN (SELECT target_id FROM bin_items WHERE kind = 'branch')`,
    // Purged subtree roots can still be identified by the shared deletion mark of their children.
    `UPDATE slots AS s SET branch_deleted = 1 WHERE s.deleted_at IS NOT NULL AND s.bin_item_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM slots child INDEXED BY slots_parent
        WHERE child.parent_slot_id = s.id AND child.bin_item_id = s.bin_item_id)
      AND NOT EXISTS (SELECT 1 FROM slots parent WHERE parent.id = s.parent_slot_id AND parent.bin_item_id = s.bin_item_id)`,
    // The rest of the purged slots can't say how they were deleted: a branch whose replies
    // were deleted on their own shares its mark with none of them. A purged message leaves its
    // replies live, a purged branch nothing; so one with nothing live below is taken for a
    // branch, and a reply restored from the bin later stays behind it (ARCHITECTURE §3.11).
    `UPDATE slots AS s SET branch_deleted = 1 WHERE s.purged_at IS NOT NULL AND s.branch_deleted = 0
      AND NOT EXISTS (
        WITH RECURSIVE below(id) AS (
          SELECT id FROM slots INDEXED BY slots_parent WHERE parent_slot_id = s.id
          UNION ALL SELECT c.id FROM slots c INDEXED BY slots_parent JOIN below ON c.parent_slot_id = below.id
        )
        SELECT 1 FROM below JOIN slots x ON x.id = below.id WHERE x.deleted_at IS NULL)`
  ]),
  "0015_composer_save_receipts": runAll([
    `CREATE TABLE composer_save_receipts (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      recovered INTEGER NOT NULL CHECK (recovered IN (0, 1)),
      PRIMARY KEY (chat_id, operation_id)
    ) STRICT`
  ]),
  "0016_inspector": runAll(inspector)
}

export const Migrations = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) })
