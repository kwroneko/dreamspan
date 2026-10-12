// Migrations through the real migrator and writer connection settings.
import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { tempDir } from "./support/tempDir.ts"

/** The migrations that run before `name`. The migrator skips anything older than the latest it has run. */
const before = (name: string) => Object.fromEntries(Object.entries(migrations).filter(([key]) => key < name))
const beforeProviders = before("0005_providers")

describe("0005_providers", () => {
  it.effect("refuses to recreate connections that already hold rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(beforeProviders) })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
      yield* sql`INSERT INTO connections (id, owner_user_id, name, api, created_at, updated_at)
        VALUES ('c', 'u', 'Kept', 'openai-completions', 1, 1)`

      const exit = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      const kept = yield* sql<{ name: string }>`SELECT name FROM connections`
      assert.deepStrictEqual(kept, [{ name: "Kept" }])
    }).pipe(Effect.provide(writerConnection(join(tempDir("mig"), "db.sqlite"))))
  )
})

describe("0006_credentials", () => {
  const beforeCredentials = before("0006_credentials")

  it.effect("refuses to retire per-connection keys while a connection holds one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(beforeCredentials) })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
      yield* sql`INSERT INTO connections (id, owner_user_id, name, kind, api, api_key_enc, key_hint, created_at, updated_at)
        VALUES ('c', 'u', 'Keyed', 'openai-chat', 'openai-completions', x'00', 'abcd', 1, 1)`

      const exit = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      const kept = yield* sql<{ key_hint: string }>`SELECT key_hint FROM connections`
      assert.deepStrictEqual(kept, [{ key_hint: "abcd" }])
    }).pipe(Effect.provide(writerConnection(join(tempDir("mig"), "db.sqlite"))))
  )
})

describe("0013_draft_sessions and 0014_deleted_subtree_roots", () => {
  it.effect("keep drafts as they were and take purged slots with nothing live below for branches", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(before("0013_draft_sessions")) })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('chat', 'u', 'rp', 'active', 1)`
      yield* sql`INSERT INTO lanes (id, chat_id, name, created_at) VALUES ('lane', 'chat', 'main', 1)`
      yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, field, content, status, row_version, created_at, updated_at)
        VALUES ('d', 'u', 'composer', 'chat', '', 'typed', 'active', 4, 1, 2)`
      yield* sql`INSERT INTO draft_history (draft_id, seq, kind, first_at, at, start, removed, inserted)
        VALUES ('d', 1, 'edit', 1, 2, 0, '', 'typed')`
      // As the earlier code left them: a branch purged after its only reply was deleted on its
      // own (no shared mark), and a message purged with its reply live.
      const slots = [
        ["root", null, 0, null, null, null],
        ["branch", "root", 1, "gone-branch", 10, 11],
        ["reply", "branch", 2, "reply-item", 9, null],
        ["message", "root", 1, "gone-message", 10, 11],
        ["live", "message", 2, null, null, null]
      ] as const
      // A version and its slot point at each other: one transaction, for the deferred keys.
      yield* sql.withTransaction(
        Effect.forEach(slots, ([id, parent, depth, mark, deleted, purged]) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
          VALUES (${`v-${id}`}, ${id}, 0, 'complete', 'human', '', 'verbatim', 'user_written', 1, 1)`
            yield* sql`INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at, bin_item_id, deleted_at, purged_at)
          VALUES (${id}, 'chat', 'lane', ${parent}, ${depth}, ${`v-${id}`}, 1, ${mark}, ${deleted}, ${purged})`
          })
        )
      )
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })

      const [draft] = yield* sql<{ session: number; text_version: number }>`SELECT session, text_version FROM drafts`
      assert.deepStrictEqual(draft, { session: 1, text_version: 4 })
      assert.deepStrictEqual(yield* sql`SELECT displaced FROM draft_history`, [{ displaced: 0 }])
      const barriers = yield* sql<{ id: string }>`SELECT id FROM slots WHERE branch_deleted = 1`
      assert.deepStrictEqual(
        barriers.map((row) => row.id),
        ["branch"]
      )
    }).pipe(Effect.provide(writerConnection(join(tempDir("mig"), "db.sqlite"))))
  )
})
