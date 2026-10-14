// Read handlers for chat setup, speakers and the send queue (DESIGN §2.1, §2.2). They run
// in the reader workers; every one touches only the acting user's rows.
import { type ChatId, ChatSummary, type EntityId } from "@rp/shared/chat.ts"
import { CardForChat, CardUsage } from "@rp/shared/chatSetupApi.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { loadCards } from "./cards.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { chatQueue } from "./queueRows.ts"
import { query } from "./tx.ts"

export const makeChatSetupReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ListCards: ({ userId }) =>
      loadCards(sql, userId, null).pipe(
        Effect.map((cards) => cards.map(({ card }) => card)),
        query("ListCards")
      ),

    // One query for the whole grid (DESIGN §2.1): each live card that isn't a persona, read
    // from the ref loadCards picks, with the chats it joined on any branch (a card that left a
    // chat still took part in it), the last message among them, and the latest of them. Per
    // card, an index seek on the cards each chat joined (`state_events_participants`); the
    // `+` keeps the column's affinity off the indexed expression, so the seek is used.
    CardUsage: ({ userId }) =>
      sql<{
        entity_id: string
        ref_id: string
        head_revision_id: string
        label: string
        subtitle: string
        name: unknown
        avatar: unknown
        used: string
      }>`
        WITH cards AS (
          SELECT e.id AS entity_id, r.id AS ref_id, r.head_revision_id, r.label, r.subtitle
          FROM entities e
          JOIN entity_refs r ON r.id = (
            SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id AND r2.ref_kind <> 'chat_override'
            ORDER BY r2.ref_kind = 'upstream' DESC, r2.created_at, r2.id LIMIT 1)
          WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.purged_at IS NULL
            AND e.deleted_at IS NULL AND e.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id AND t.tag = 'persona')
        )
        SELECT cards.*, json_extract(rev.doc_json, '$.name') AS name,
          json_extract(rev.doc_json, '$.avatar_media_id') AS avatar,
          (SELECT json_object(
              'chats', count(DISTINCT c.id),
              'last', max(c.last_message_at),
              'latest', substr(max(printf('%016d', coalesce(c.last_message_at, c.created_at)) || c.id), 17))
            FROM state_events s JOIN chats c ON c.id = s.chat_id
            WHERE json_extract(s.value_json, '$.entity') = +cards.entity_id
              AND s.key = 'participant.join' AND s.superseded_by_changeset IS NULL
              AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL) AS used
        FROM cards JOIN entity_revisions rev ON rev.id = cards.head_revision_id
        ORDER BY cards.label COLLATE NOCASE, cards.entity_id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => {
            const used = JSON.parse(row.used) as { chats: number; last: number | null; latest: string | null }
            const name = typeof row.name === "string" ? row.name.trim() : ""
            return new CardUsage({
              entityId: row.entity_id as EntityId,
              refId: row.ref_id as RefId,
              headRevisionId: row.head_revision_id as RevisionId,
              label: row.label,
              subtitle: row.subtitle,
              name: name === "" ? row.label : name,
              avatarMediaId: typeof row.avatar === "string" ? row.avatar : null,
              chats: used.chats,
              lastMessageAt: used.last,
              latestChatId: (used.latest || null) as ChatId | null
            })
          })
        ),
        query("CardUsage")
      ),

    // One indexed read per chat: the cast is everyone a participant.join names on any branch
    // (the list doesn't walk paths), and the last message is the active leaf's.
    ChatSummaries: ({ userId, chatIds }) =>
      Effect.gen(function* () {
        const summaries: Array<ChatSummary> = []
        for (const chatId of chatIds.slice(0, 200)) {
          const [chat] = yield* sql<{ leaf: string | null }>`
            SELECT active_leaf_slot_id AS leaf FROM chats
            WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
          if (!chat) continue
          const joined = yield* sql<{ entity: string }>`
            SELECT json_extract(value_json, '$.entity') AS entity FROM state_events
            WHERE chat_id = ${chatId} AND key = 'participant.join' AND superseded_by_changeset IS NULL
            GROUP BY entity ORDER BY min(seq)`
          const ids = joined.map((row) => row.entity as EntityId)
          const cards = ids.length === 0 ? [] : yield* loadCards(sql, userId, ids)
          const byId = new Map(cards.map(({ card }) => [card.entityId as string, card]))
          const [leaf] =
            chat.leaf === null
              ? []
              : yield* sql<{ depth: number; speaker: string | null; writer: string; text: string }>`
                  SELECT s.depth, v.speaker_entity_id AS speaker, v.writer, substr(v.content, 1, 240) AS text
                  FROM slots s JOIN versions v ON v.id = s.selected_version_id
                  WHERE s.id = ${chat.leaf} AND s.chat_id = ${chatId}`
          summaries.push(
            new ChatSummary({
              chatId,
              cast: ids.flatMap((id) => byId.get(id) ?? []),
              messages: leaf ? leaf.depth + 1 : 0,
              last: leaf ? { speaker: leaf.speaker as EntityId | null, writer: leaf.writer, text: leaf.text } : null
            })
          )
        }
        return summaries
      }).pipe(query("ChatSummaries")),

    CastCards: ({ userId, entityIds }) =>
      loadCards(sql, userId, entityIds).pipe(
        Effect.map((cards) => cards.map(({ card }) => card)),
        query("CastCards")
      ),

    GetCardForChat: ({ userId, entityId }) =>
      Effect.gen(function* () {
        const [found] = yield* loadCards(sql, userId, [entityId])
        if (found === undefined || found.card.inBin) return yield* new NotFound({ entity: "card", id: entityId })
        const { card, greetings, description, personality, scenario } = found
        return new CardForChat({ card, greetings, description, personality, scenario })
      }).pipe(query("GetCardForChat")),

    ListQueued: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (chat?.n !== 1) return yield* new NotFound({ entity: "chat", id: chatId })
        return yield* chatQueue(sql, chatId)
      }).pipe(query("ListQueued"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
