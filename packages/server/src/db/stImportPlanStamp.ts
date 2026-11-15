// Per-chat stamps for the re-import preview (ARCHITECTURE.md §13 "Re-import preview"). The
// preview records one per chat it reads, before it maps any file; the confirmed import's
// write of a file into that chat (`StImportCommitChat`) reads it again first, in the same
// synchronous transaction as the write, and writes nothing for the file when it differs.
//
// No new column or trigger: a chat's existing counters already move on every change the
// import's matcher and its finish read. `shell_stamp` moves on every message, swipe, edit,
// selection, deletion, insertion and fork change (the baseline's shell triggers), `state_seq`
// on every fork override (hides included) and state event, `row_version` on the chat row
// itself; `deleted_at` is the recycle bin. With them, the import records of files in the
// chat. (The `lcm_stamp` of job/planperf2 is a different stamp: it deliberately does not
// move on appends, which change matching, so it can't stand in for this one; this reads only
// columns the baseline already has, so the two don't touch.)
import { createHash } from "node:crypto"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ST_CHAT_RECORD } from "./ops.ts"

interface ChatRow {
  readonly id: string
  readonly row_version: number
  readonly shell_stamp: number
  readonly state_seq: number
  readonly current_fork_id: string | null
  readonly active_leaf_slot_id: string | null
  readonly deleted_at: number | null
}

interface RecordRow {
  readonly id: string
  readonly status: string
  readonly payload_json: string
  readonly chat_id: string | null
}

/** One chat's stamp from its row and its import records (ordered by id). */
const stampOf = (chat: ChatRow, records: ReadonlyArray<RecordRow>) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        chat.row_version,
        chat.shell_stamp,
        chat.state_seq,
        chat.current_fork_id,
        chat.active_leaf_slot_id,
        chat.deleted_at,
        records.map((record) => [record.id, record.status, record.payload_json])
      ])
    )
    .digest("hex")

const chatColumns = "id, row_version, shell_stamp, state_seq, current_fork_id, active_leaf_slot_id, deleted_at"

/** Every chat of the user's, by id: what the preview records before mapping its files. */
export const stImportChatStamps = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const chats = yield* sql<ChatRow>`SELECT ${sql.literal(chatColumns)} FROM chats
      WHERE owner_user_id = ${userId} ORDER BY id`
    const records = yield* sql<RecordRow>`
      SELECT id, status, payload_json, json_extract(payload_json, '$.chatId') AS chat_id FROM jobs
      WHERE owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD} ORDER BY id`
    const byChat = new Map<string, Array<RecordRow>>()
    for (const record of records) {
      if (record.chat_id === null) continue
      const list = byChat.get(record.chat_id) ?? []
      list.push(record)
      byChat.set(record.chat_id, list)
    }
    return Object.fromEntries(chats.map((chat) => [chat.id, stampOf(chat, byChat.get(chat.id) ?? [])]))
  })

/** One chat's stamp, as `stImportChatStamps` gives it; null for a chat that isn't the user's. */
export const stImportChatStamp = (sql: SqlClient.SqlClient, userId: UserId, chatId: string) =>
  Effect.gen(function* () {
    const [chat] = yield* sql<ChatRow>`SELECT ${sql.literal(chatColumns)} FROM chats
      WHERE id = ${chatId} AND owner_user_id = ${userId}`
    if (chat === undefined) return null
    const records = yield* sql<RecordRow>`
      SELECT id, status, payload_json, json_extract(payload_json, '$.chatId') AS chat_id FROM jobs
      WHERE owner_user_id = ${userId} AND kind = ${ST_CHAT_RECORD}
        AND json_extract(payload_json, '$.chatId') = ${chatId} ORDER BY id`
    return stampOf(chat, records)
  })
