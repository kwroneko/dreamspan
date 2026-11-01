import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { baseline } from "./baseline.ts"

/** node:sqlite prepares one statement at a time, so DDL is kept as a list of statements. */
const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  })

/**
 * When each preset was last used for a reply (`entity_refs.last_used_at`, which `StartRollout`
 * records from then on), from the generations already made: the latest whose context snapshot
 * names the ref, and for a chat's own copy the entry it follows too. Data only: the column is
 * in the baseline, so a database kept across deploys takes it.
 */
const presetLastUsed = [
  `WITH used AS (
     SELECT json_extract(p.context_snapshot_json, '$.inputs.preset.ref') AS ref_id, r.created_at, c.owner_user_id
     FROM rollouts r JOIN rollout_payloads p ON p.rollout_id = r.id JOIN chats c ON c.id = r.chat_id
     WHERE r.kind = 'generation' AND p.context_snapshot_json IS NOT NULL
   ), targets AS (
     SELECT u.ref_id AS id, u.created_at, u.owner_user_id FROM used u WHERE u.ref_id IS NOT NULL
     UNION ALL
     SELECT o.follows_ref_id, u.created_at, u.owner_user_id FROM used u
     JOIN entity_refs o ON o.id = u.ref_id AND o.ref_kind = 'chat_override'
   ), latest AS (
     SELECT t.id, max(t.created_at) AS at FROM targets t
     JOIN entity_refs r ON r.id = t.id JOIN entities e ON e.id = r.entity_id AND e.owner_user_id = t.owner_user_id
     GROUP BY t.id
   )
   UPDATE entity_refs SET last_used_at = (SELECT at FROM latest WHERE latest.id = entity_refs.id)
   WHERE id IN (SELECT id FROM latest) AND (last_used_at IS NULL OR last_used_at < (SELECT at FROM latest WHERE latest.id = entity_refs.id))`
]

// Migrations run in the writer worker, before any reader connection is opened. The baseline is
// the schema; databases are kept across deploys, so what comes after it must apply to one.
export const migrations = {
  "0001_baseline": runAll(baseline),
  "0002_preset_last_used": runAll(presetLastUsed)
}

/**
 * A database whose ledger holds ids this code doesn't know was made before the baseline
 * (or by a newer build). The migrator would skip what it thinks is older and run the rest
 * on top of a schema it never made, so it is refused before the migrator starts.
 */
const refuseUnknownLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [ledger] = yield* sql<{
    n: number
  }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'effect_sql_migrations'`
  if (ledger!.n === 0) return
  const known = new Set(Object.keys(migrations).map((key) => Number(key.slice(0, key.indexOf("_")))))
  const rows = yield* sql<{ migration_id: number; name: string }>`SELECT migration_id, name FROM effect_sql_migrations`
  const unknown = rows.filter(
    (row) => !known.has(row.migration_id) || !(`${String(row.migration_id).padStart(4, "0")}_${row.name}` in migrations)
  )
  if (unknown.length === 0) return
  const ids = unknown.map((row) => `${String(row.migration_id).padStart(4, "0")}_${row.name}`).join(", ")
  return yield* Effect.die(
    new Error(
      `This database was made by a different version of the schema (ledger holds ${ids}; this build knows ${Object.keys(migrations).join(", ")}). ` +
        `Migrations were squashed into one baseline and old databases are not carried over: start from an empty data directory.`
    )
  )
})

export const Migrations = SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
  Layer.provide(Layer.effectDiscard(refuseUnknownLedger))
)
