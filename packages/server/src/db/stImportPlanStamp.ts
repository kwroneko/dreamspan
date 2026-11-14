// Account-scoped inputs checked before mapping and inside StImportBegin. This guards
// admission only: the subsequent import batches retain their existing concurrency rules.
import { createHash } from "node:crypto"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ST_CHAT_RECORD } from "./ops.ts"

/**
 * Each chat's counters: `shell_stamp` moves on every message, swipe, edit, selection,
 * deletion and fork change (the baseline's triggers), `state_seq` on every fork override and
 * state event (hides included), `row_version` and `deleted_at` on the chat itself. With the
 * complete import records, plus the library stamp. Timestamps alone are not revisions.
 */
export const stImportPlanStamp = (sql: SqlClient.SqlClient, userId: UserId, _chatIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const chats = yield* sql<{
      id: string
      shell_stamp: number
      state_seq: number
      row_version: number
      deleted_at: number | null
    }>`SELECT id, shell_stamp, state_seq, row_version, deleted_at FROM chats
      WHERE owner_user_id = ${userId}
      ORDER BY id`
    const records = yield* sql<{ id: string; status: string; payload_json: string; updated_at: number }>`
      SELECT id, status, payload_json, updated_at FROM jobs
      WHERE owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD} ORDER BY id`
    const library = yield* sql`SELECT stamp FROM shell_user_stamps WHERE user_id = ${userId}`
    return createHash("sha256")
      .update(
        JSON.stringify({
          chats: chats.map((row) => [row.id, row.shell_stamp, row.state_seq, row.row_version, row.deleted_at]),
          records,
          library
        })
      )
      .digest("hex")
  })
