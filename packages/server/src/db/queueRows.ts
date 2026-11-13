// The send queue's rows (migration 0012), read by the readers and the writer. Every query
// reaches the owner through the chat: a queued message has no owner of its own.
import { type ChatId, type EntityId, type ForkId, QueuedMessage, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export interface QueuedRow {
  readonly id: string
  readonly chat_id: string
  readonly reply_slot_id: string
  /** The fork it posts in; null for one queued before forks. */
  readonly fork_id: string | null
  readonly seq: number
  readonly kind: "message" | "generate"
  readonly images_json: string
  readonly content: string
  /** The typed text before regex scripts rewrote it, and what they did (as on versions). */
  readonly raw_content: string | null
  readonly rewrite_json: string | null
  readonly speaker_entity_id: string | null
  readonly reply_speaker_entity_id: string | null
  readonly direction: string | null
  /** For 'message': 1 when it posts without a reply (every character muted, migration 0048). */
  readonly no_reply: number
  /** 1: a reply of a round; `held` 1: its round stopped, waiting for Continue round. */
  readonly round: number
  readonly held: number
  /** 1: the reply's speaker is Auto's pick, which the decision model may change (DESIGN §2.3). */
  readonly auto_pick: number
  /** A round's entry: the slot of the round's first reply, once posted. */
  readonly round_start_slot_id: string | null
  /** A side chat's story position (StoryAt JSON) for the reply it asks for; null elsewhere. */
  readonly story_at_json: string | null
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
    images: JSON.parse(row.images_json),
    speakerEntityId: row.speaker_entity_id as EntityId | null,
    replySpeakerEntityId: row.reply_speaker_entity_id as EntityId | null,
    direction: row.direction,
    ...(row.round === 1
      ? {
          round: {
            held: row.held === 1,
            forkId: row.fork_id as ForkId | null,
            ...(row.auto_pick === 1 ? { decides: true } : {}),
            ...(row.round_start_slot_id === null ? {} : { startSlotId: row.round_start_slot_id as SlotId })
          }
        }
      : {}),
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
