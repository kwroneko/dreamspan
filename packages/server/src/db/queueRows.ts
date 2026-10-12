// The send queue's rows (migration 0012), read by the readers and the writer. Every query
// reaches the owner through the chat: a queued message has no owner of its own.
import { type ChatId, type EntityId, QueuedMessage, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export interface QueuedRow {
  readonly id: string
  readonly chat_id: string
  readonly reply_slot_id: string
  readonly seq: number
  readonly kind: "message" | "generate"
  readonly content: string
  readonly speaker_entity_id: string | null
  readonly reply_speaker_entity_id: string | null
  readonly direction: string | null
  readonly row_version: number
  readonly created_at: number
}

export const toQueued = (row: QueuedRow) =>
  new QueuedMessage({
    id: row.id,
    chatId: row.chat_id as ChatId,
    replySlotId: row.reply_slot_id as SlotId,
    kind: row.kind,
    content: row.content,
    speakerEntityId: row.speaker_entity_id as EntityId | null,
    replySpeakerEntityId: row.reply_speaker_entity_id as EntityId | null,
    direction: row.direction,
    rowVersion: row.row_version,
    createdAt: row.created_at
  })

/** A chat's queue, in order. The caller has checked the chat is the user's. */
export const chatQueue = (sql: SqlClient.SqlClient, chatId: string) =>
  sql<QueuedRow>`SELECT * FROM queued_messages WHERE chat_id = ${chatId} ORDER BY seq`.pipe(
    Effect.map((rows) => rows.map(toQueued))
  )

/** One entry of the user's, in a live chat. */
export const ownedQueued = (sql: SqlClient.SqlClient, userId: UserId, queuedId: string) =>
  sql<QueuedRow>`SELECT q.* FROM queued_messages q JOIN chats c ON c.id = q.chat_id
    WHERE q.id = ${queuedId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`.pipe(
    Effect.map(([row]) => row ?? null)
  )
