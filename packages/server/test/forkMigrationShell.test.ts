// The fork migrations (0052 to 0055) on a database as 0051 leaves it, with what the shell and
// the notes changes added before them: `current_leaf_slot_id`, pins by divergence slot, a queued
// message with no reply, and state events of a note. Synthetic rows only.
import { DatabaseSync } from "node:sqlite"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { databaseFile, writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { tempDir } from "./support/tempDir.ts"

describe("fork migrations after the shell and notes migrations", () => {
  it.live(
    "keep pins, the queue's no-reply flag and events, and make a fork per leaf",
    () => {
      const dataDir = tempDir("forks-after-shell")
      return Effect.gen(function* () {
        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord(Object.fromEntries(Object.entries(migrations).filter(([k]) => k < "0052")))
        }).pipe(Effect.provide(writerConnection(databaseFile(dataDir))))
        const db = new DatabaseSync(databaseFile(dataDir))
        try {
          db.exec(`PRAGMA foreign_keys = ON; BEGIN;
          INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1);
          INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('chat', 'u', 'rp', 'active', 1);
          INSERT INTO lanes (id, chat_id, name, created_at) VALUES ('lane', 'chat', 'main', 1);`)
          const version = db.prepare(`INSERT INTO versions
          (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
          VALUES (?, ?, 0, 'complete', 'model', 'Synthetic', 'verbatim', 'generated', 1, 1)`)
          const slot = db.prepare(`INSERT INTO slots
          (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at)
          VALUES (?, 'chat', 'lane', ?, ?, ?, 1)`)
          const add = (id: string, parent: string | null, depth: number) => {
            version.run(`v-${id}`, id)
            slot.run(id, parent, depth, `v-${id}`)
          }
          add("root", null, 0)
          add("a", "root", 1)
          add("b", "a", 2)
          add("c", "a", 2)
          db.exec(`UPDATE chats SET active_leaf_slot_id = 'b', current_leaf_slot_id = 'c' WHERE id = 'chat';
          INSERT INTO chat_pins (user_id, chat_id, fork_id) VALUES ('u', 'chat', 'c');
          INSERT INTO queued_messages (id, chat_id, reply_slot_id, seq, kind, content, no_reply, created_at, updated_at)
            VALUES ('q', 'chat', 'b', 1, 'message', 'Waiting', 1, 1, 1);
          INSERT INTO state_events (id, chat_id, slot_id, seq, key, scope, value_json, origin, created_at)
            VALUES ('e', 'chat', 'a', 1, 'note.on', NULL, '{"on":true}', 'user', 1);
          COMMIT`)
        } finally {
          db.close()
        }
        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
          Effect.provide(writerConnection(databaseFile(dataDir)))
        )
        const after = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
        try {
          const forks = after.prepare("SELECT id, tip_slot_id FROM forks ORDER BY tip_slot_id").all() as Array<{
            id: string
            tip_slot_id: string
          }>
          assert.deepStrictEqual(
            forks.map((f) => f.tip_slot_id),
            ["b", "c"]
          )
          const chat = after
            .prepare("SELECT current_fork_id, active_leaf_slot_id, current_leaf_slot_id FROM chats WHERE id = 'chat'")
            .get() as { current_fork_id: string; active_leaf_slot_id: string; current_leaf_slot_id: string }
          // The current fork is the one at the active leaf; the shell's own column stays, unread.
          assert.strictEqual(chat.current_fork_id, forks.find((f) => f.tip_slot_id === "b")!.id)
          assert.strictEqual(chat.active_leaf_slot_id, "b")
          assert.strictEqual(chat.current_leaf_slot_id, "c")
          assert.deepStrictEqual(after.prepare("SELECT user_id, chat_id, fork_id FROM chat_pins").all(), [
            { user_id: "u", chat_id: "chat", fork_id: "c" }
          ])
          const queued = after.prepare("SELECT no_reply, content, fork_id FROM queued_messages").all()
          assert.deepStrictEqual(queued, [
            { no_reply: 1, content: "Waiting", fork_id: forks.find((f) => f.tip_slot_id === "b")!.id }
          ])
          const event = after
            .prepare("SELECT key, value_json, slot_chain_id IS NOT NULL AS chained FROM state_events")
            .all()
          assert.deepStrictEqual(event, [{ key: "note.on", value_json: '{"on":true}', chained: 1 }])
          assert.strictEqual(
            (after.prepare("SELECT count(*) AS n FROM slots WHERE fork_id IS NULL").get() as { n: number }).n,
            0
          )
          assert.strictEqual((after.prepare("SELECT count(*) AS n FROM fork_overrides").get() as { n: number }).n, 0)
          assert.strictEqual(
            (after.prepare("SELECT count(*) AS n FROM versions WHERE fork_id IS NOT NULL").get() as { n: number }).n,
            0
          )
        } finally {
          after.close()
        }
      })
    },
    60_000
  )
})
