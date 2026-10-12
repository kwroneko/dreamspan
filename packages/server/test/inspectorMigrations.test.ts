import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { join } from "node:path"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { tempDir } from "./support/tempDir.ts"
const before = Object.fromEntries(Object.entries(migrations).filter(([k]) => k < "0013"))
it.effect(
  "0013 through 0018 in order on a populated pre-0013 database preserve drafts, history, payloads and issues",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(before) })
      yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES('u','u','u','admin',1)`
      yield* sql`INSERT INTO chats(id,owner_user_id,kind,status,created_at) VALUES('c','u','rp','active',1)`
      yield* sql`INSERT INTO drafts(id,user_id,target_kind,target_id,field,content,status,row_version,created_at,updated_at) VALUES('d','u','composer','c','','KEEP ME','active',7,1,2)`
      yield* sql`INSERT INTO draft_history(draft_id,seq,kind,first_at,at,start,removed,inserted) VALUES('d',1,'edit',1,2,0,'','KEEP ME')`
      const issue = { kind: "lorebook_issue", message: "Lorebook token allowance reached; entries were left out." }
      const snapshot = JSON.stringify({
        assemblerVersion: 6,
        issues: [{ kind: "history_truncated", message: "History too long" }, issue]
      })
      yield* sql`INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES('r','c','generation','completed','narrator','interactive',1,1)`
      yield* sql`INSERT INTO rollout_payloads(rollout_id,context_snapshot_json) VALUES('r',${snapshot})`
      const completed = { ...before }
      for (const [key, value] of Object.entries(migrations).filter(([k]) => k >= "0013")) {
        completed[key] = value
        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(completed) })
        if (key === "0015_composer_save_receipts")
          yield* sql`INSERT INTO composer_save_receipts(chat_id,operation_id,recovered) VALUES('c','pending-copy',0)`
      }
      const [draft] = yield* sql`SELECT content,row_version,session,text_version FROM drafts`
      assert.deepStrictEqual(draft, { content: "KEEP ME", row_version: 7, session: 1, text_version: 7 })
      assert.deepStrictEqual(yield* sql`SELECT displaced,inserted FROM draft_history`, [
        { displaced: 0, inserted: "KEEP ME" }
      ])
      assert.deepStrictEqual(yield* sql`SELECT * FROM composer_save_receipts`, [
        { chat_id: "c", operation_id: "pending-copy", recovered: 0, displaced_json: null }
      ])
      assert.deepStrictEqual(yield* sql`SELECT context_snapshot_json,sent_context_json FROM rollout_payloads`, [
        { context_snapshot_json: snapshot, sent_context_json: null }
      ])
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])
      const [row] = yield* sql<{ context_issues_json: string }>`SELECT context_issues_json FROM rollouts`

      assert.deepStrictEqual(JSON.parse(row!.context_issues_json), JSON.parse(snapshot).issues)
    }).pipe(Effect.provide(writerConnection(join(tempDir("seam-migrations"), "db.sqlite"))))
)
