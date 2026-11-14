// What a re-import preview was worked out against (ARCHITECTURE.md §13 "Re-import preview"):
// one read the preview takes in a reader worker when it finishes, and the writer takes again
// inside StImportBegin's transaction when the user confirms. Equal stamps mean the chats the
// preview mapped files into, and the import records the matcher reads, are as they were;
// anything else and the import isn't started, so it never writes something other than what
// was shown. Database reads only: it runs inside a write transaction.
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ST_CHAT_RECORD } from "./ops.ts"

/**
 * Each chat's counters: `shell_stamp` moves on every message, swipe, edit, selection,
 * deletion and fork change (the baseline's triggers), `state_seq` on every fork override and
 * state event (hides included), `row_version` and `deleted_at` on the chat itself. With the
 * number and latest change of the user's import records, which an import run moves.
 */
export const stImportPlanStamp = (sql: SqlClient.SqlClient, userId: UserId, chatIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const chats = yield* sql<{
      id: string
      shell_stamp: number
      state_seq: number
      row_version: number
      deleted_at: number | null
    }>`SELECT id, shell_stamp, state_seq, row_version, deleted_at FROM chats
      WHERE owner_user_id = ${userId} AND id IN (SELECT value FROM json_each(${JSON.stringify([...chatIds])}))
      ORDER BY id`
    const [records] = yield* sql<{ n: number; latest: number | null }>`
      SELECT count(*) AS n, max(updated_at) AS latest FROM jobs
      WHERE owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD}`
    return JSON.stringify({
      chats: chats.map((row) => [row.id, row.shell_stamp, row.state_seq, row.row_version, row.deleted_at]),
      records: [records?.n ?? 0, records?.latest ?? null]
    })
  })
