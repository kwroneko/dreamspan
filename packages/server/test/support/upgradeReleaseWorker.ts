// Builds and inspects the synthetic release database off the test thread.
import { createHash } from "node:crypto"
import { inspect as inspectError } from "node:util"
import { parentPort, workerData } from "node:worker_threads"
import { DEFAULT_DISPLAY_PREFS } from "@dreamspan/shared/chatApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { readerConnection, toStorageError, writerConnection } from "../../src/db/connection.ts"
import { migrate, migrationDefinitions, type MigrationDefinition } from "../../src/db/migrations.ts"
import { readReleases, releasedMigrationProblems } from "../../src/db/releases.ts"
import { docFor } from "./docs.ts"

const { file, seed } = workerData as { file: string; seed: boolean }

const release0 = readReleases().find((release) => release.release === 0)!
const released = Object.fromEntries(
  Object.keys(release0.migrations).map((key) => [
    key,
    (migrationDefinitions as Record<string, MigrationDefinition>)[key]!
  ])
)

const library = (["card", "lorebook", "preset"] as const).map((kind) => {
  const label = `Fixture ${kind}`
  const doc = docFor(kind, label)
  const json = JSON.stringify(doc)
  return { kind, label, json, hash: createHash("sha256").update(json).digest("hex"), version: doc.schema_version }
})
const displays = (
  [
    ["keeper", "never"],
    ["reader", "always"]
  ] as const
).map(([user, enterSends]) => ({
  user,
  json: JSON.stringify({ ...DEFAULT_DISPLAY_PREFS, enterSends, coverageRail: true })
}))

const populate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES
    ('keeper', 'keeper', 'Keeper', 'admin', 1), ('reader', 'reader', 'Reader', 'user', 1)`
  for (const { user, json } of displays) {
    yield* sql`INSERT INTO settings (scope, scope_id, key, value_json, revision, updated_at)
      VALUES ('user', ${user}, 'display', ${json}, 3, 10)`
  }
  for (const { kind, label, json, hash, version } of library) {
    yield* sql`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES (${kind}, 'keeper', ${kind}, 1)`
    yield* sql`INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
      VALUES (${kind + "-rev"}, ${kind}, ${json}, ${hash}, ${version}, 'user', 1)`
    yield* sql`INSERT INTO entity_refs (id, entity_id, head_revision_id, label, created_at, updated_at)
      VALUES (${kind + "-ref"}, ${kind}, ${kind + "-rev"}, ${label}, 1, 1)`
  }
  yield* sql`INSERT INTO media_assets (id, sha256, mime, byte_size, path, created_at)
    VALUES ('map', ${"ab".repeat(32)}, 'text/plain', 16, 'map.txt', 1)`
  yield* sql`INSERT INTO file_versions (id, owner_user_id, path, media_id, byte_size, origin, actor_user_id, created_at)
    VALUES ('map-first', 'keeper', 'maps/map.txt', 'map', 16, 'upload', 'keeper', 1)`
  yield* sql`INSERT INTO file_shares (id, owner_user_id, path, inode, grantee_user_id, mode, created_at)
    VALUES ('maps-share', 'keeper', 'maps', 1, 'reader', 'view', 1)`

  for (const [chat, user] of [
    ["harbor", "keeper"],
    ["orchard", "keeper"],
    ["station", "reader"]
  ] as const) {
    // A 900-message trunk and 99 alternate replies from its penultimate message.
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, title, title_source, created_at, last_message_at)
      VALUES (${chat}, ${user}, 'rp', 'active', ${chat}, 'user', 1, 900)`
    const trunk = sql`WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n < 899)`
    yield* sql`${trunk} INSERT INTO version_records
        (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
      SELECT ${chat} || '-' || n || '-v0', ${chat} || '-' || n, 0, 'complete',
        CASE WHEN n % 2 = 0 THEN 'human' ELSE 'model' END, 'Message at ' || ${chat} || '-' || n,
        'verbatim', CASE WHEN n % 2 = 0 THEN 'user_written' ELSE 'generated' END, n+1, n+1, ${chat} FROM seq`
    yield* sql`${trunk}
      INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at, fork_id)
      SELECT ${chat} || '-' || n, ${chat}, CASE WHEN n > 0 THEN ${chat} || '-' || (n-1) END, n,
        ${chat} || '-' || n || '-v0', n+1, ${chat}
      FROM seq ORDER BY n`
    yield* sql`UPDATE forks SET tip_slot_id = ${chat + "-899"} WHERE id = ${chat}`
    yield* sql`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 99)
      INSERT INTO forks (id, chat_id, parent_fork_id, base_slot_id, name, name_user, created_at)
      SELECT ${chat} || '-fork-' || n, ${chat}, ${chat}, ${chat + "-898"}, 'Alternate ' || n, 1, 900+n FROM seq`
    yield* sql`INSERT INTO version_records
        (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
      SELECT id || '-reply-v0', id || '-reply', 0, 'complete', 'model', 'Message at ' || id || '-reply',
        'verbatim', 'generated', created_at, created_at, id FROM forks WHERE parent_fork_id = ${chat}`
    yield* sql`INSERT INTO slots (id, chat_id, parent_slot_id, depth, selected_version_id, created_at, fork_id)
      SELECT id || '-reply', ${chat}, base_slot_id, 899, id || '-reply-v0', created_at, id
      FROM forks WHERE parent_fork_id = ${chat}`
    yield* sql`UPDATE forks SET tip_slot_id = id || '-reply' WHERE parent_fork_id = ${chat}`
    yield* sql`INSERT INTO summary_revisions (id, summary_id, content, token_count, origin, created_at)
      VALUES (${chat + "-summary-rev"}, ${chat + "-summary"}, 'The group reached the gate.', 6, 'generated', 9)`
    yield* sql`INSERT INTO summaries
        (id, chat_id, level, selected_revision_id, first_slot_id, last_slot_id, slot_count, created_at)
      VALUES (${chat + "-summary"}, ${chat}, 1, ${chat + "-summary-rev"}, ${chat + "-0"}, ${chat + "-7"}, 8, 9)`
    yield* sql`INSERT INTO summary_inputs (summary_id, ordinal, slot_id, version_id)
      SELECT ${chat + "-summary"}, depth, id, selected_version_id FROM slots WHERE chat_id = ${chat} AND depth < 8`
    yield* sql`UPDATE summaries SET sealed = 1 WHERE id = ${chat + "-summary"}`
  }
  yield* sql`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 40)
    INSERT INTO version_records
      (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at, authoring_fork_id)
    SELECT 'harbor-899-v' || n, 'harbor-899', n, 'complete', 'model', 'Swipe ' || n,
      'verbatim', 'generated', 900+n, 900+n, 'harbor' FROM seq`
  yield* sql`UPDATE chats SET state_seq = 1 WHERE id = 'harbor'`
  yield* sql`INSERT INTO fork_overrides (id, chat_id, fork_id, seq, kind, target_id, slot_id, slot_depth, value_id)
    VALUES ('harbor-choice', 'harbor', 'harbor', 1, 'select', 'harbor-899', 'harbor-899', 899, 'harbor-899-v40')`
  yield* sql`INSERT INTO queued_messages
      (id, chat_id, reply_slot_id, seq, kind, content, created_at, updated_at, fork_id)
    VALUES ('harbor-queued', 'harbor', 'harbor-899', 1, 'message', 'Search the map.', 999, 999, 'harbor')`
  yield* sql`INSERT INTO version_attachments (version_id, ordinal, media_id, kind, alt_text, name, path)
    VALUES ('harbor-898-v0', 0, 'map', 'file', '', 'map.txt', 'maps/map.txt')`
  yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, content, updated_at)
    VALUES ('harbor-composer', 'keeper', 'composer', 'harbor', 'Check the tide.', 999)`
  yield* sql`INSERT INTO composer_images (id, draft_id, media_id, alt_text, status, kind, name)
    VALUES ('draft-map', 'harbor-composer', 'map', '', 'active', 'file', 'map.txt')`

  for (const chat of ["old-logs", "old-sketches"]) {
    const itemId = chat + "-bin"
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, title, created_at)
      VALUES (${chat}, 'keeper', 'rp', 'active', ${chat}, 1)`
    yield* sql`INSERT INTO bin_items (id, user_id, kind, target_id, chat_id, title, excerpt, origin_json, byte_size, deleted_at)
      VALUES (${itemId}, 'keeper', 'chat', ${chat}, ${chat}, ${chat}, '', '{}', 0, 1000)`
    yield* sql`UPDATE chats SET deleted_at = 1000, bin_item_id = ${itemId} WHERE id = ${chat}`
  }
})

const inspect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tables = yield* sql<{ name: string }>`SELECT name FROM pragma_table_list
    WHERE "schema" = 'main' AND type IN ('table', 'virtual')
      AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations' ORDER BY name`
  const counts: Record<string, number> = {}
  for (const { name } of tables) {
    const [row] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM ${sql(name)}`
    if (row!.count > 0) counts[name] = row!.count
  }
  return {
    counts,
    ledger: (yield* sql<{
      migration_id: number
    }>`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`).map(({ migration_id }) => migration_id),
    integrity: (yield* sql<{ integrity_check: string }>`PRAGMA integrity_check`).map((row) => row.integrity_check),
    foreignKeyErrors: yield* sql`PRAGMA foreign_key_check`
  }
})

export type ReleaseSnapshot = Effect.Success<typeof inspect>

if (seed) {
  const problems = releasedMigrationProblems(migrationDefinitions, [release0])
  if (problems.length > 0) throw new Error(problems.join("\n"))
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate(released)
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(populate).pipe(Effect.mapError(toStorageError("seed release 0")))
    }).pipe(
      Effect.provide(writerConnection(file)),
      Effect.mapError((error) => new Error(inspectError(error)))
    )
  )
}
parentPort!.postMessage(await Effect.runPromise(inspect.pipe(Effect.provide(readerConnection(file)))))
