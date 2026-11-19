import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { cardArchiveCriteria, type ArchiveCriteria } from "@dreamspan/shared/cardArchive.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { readFavourites } from "./cardFavourites.ts"

/** Shared with the query-plan regression; no documents or message text. */
export const archiveCandidatesSql = `SELECT e.id AS entityId, r.id AS refId, r.label AS name,
      json_extract(cs.fields, '$[3]') AS avatarMediaId,
      r.created_at AS addedAt,
      max(
        coalesce(r.last_used_at, 0),
        coalesce((SELECT max(v.created_at) FROM version_participants p
          JOIN versions v ON v.id = p.version_id
          JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          WHERE p.entity_id = e.id AND c.owner_user_id = ?
            AND v.origin != 'greeting' AND NOT (v.origin = 'imported' AND s.parent_slot_id IS NULL AND v.writer = 'model') AND (v.writer = 'human' OR v.content_length > 0)
            AND v.purged_at IS NULL AND s.purged_at IS NULL), 0),
        coalesce((SELECT max(er.created_at) FROM entity_revisions er
          WHERE er.entity_id = e.id AND er.origin = 'user'
            AND (json_array_length(er.parents) > 0 OR e.forked_from_entity_id IS NOT NULL)), 0),
        coalesce((SELECT max(d.updated_at) FROM drafts d WHERE d.user_id = ?
          AND d.target_kind = 'entity_field' AND d.target_id = r.id), 0),
        coalesce((SELECT max(child.forked_at) FROM entities child
          WHERE child.forked_from_entity_id = e.id AND child.owner_user_id = ?), 0)
      ) AS lastUsedAt,
      o.source_id AS fromSource,
      -- The user's own messages in the chats the card was in, for "Only tried" (cards from a source only).
      CASE WHEN o.entity_id IS NULL THEN 0 ELSE (SELECT count(DISTINCT v.slot_id) FROM version_participants p
          JOIN versions v ON v.id = p.version_id
          JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
          WHERE p.entity_id = e.id AND c.owner_user_id = ? AND v.writer = 'human'
            AND v.purged_at IS NULL AND s.purged_at IS NULL) END AS userMessages
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id
      LEFT JOIN card_summaries cs ON cs.revision_id = r.head_revision_id
      LEFT JOIN card_origins o ON o.entity_id = e.id AND o.owner_user_id = e.owner_user_id
        AND o.recognized_by = 'adopted'
    WHERE e.owner_user_id = ? AND e.kind = 'card'
      AND e.archived_at IS NULL AND e.deleted_at IS NULL AND e.purged_at IS NULL
    ORDER BY r.label COLLATE NOCASE, e.id`

/** The query's parameters: the user, once per placeholder. */
export const archiveCandidatesParams = (userId: string) => [userId, userId, userId, userId, userId]

/** No documents or message text: indexed participation and revision metadata only. */
export const archiveCandidates = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  criteria: ArchiveCriteria
) {
  const rows = yield* sql.unsafe<{
    entityId: EntityId
    refId: RefId
    name: string
    avatarMediaId: string | null
    addedAt: number
    lastUsedAt: number | null
    fromSource: string | null
    userMessages: number
  }>(archiveCandidatesSql, archiveCandidatesParams(userId))
  const favourites = new Set((yield* readFavourites(sql, userId)).on)
  const now = Date.now()
  return rows
    .map((row) => ({ ...row, lastUsedAt: row.lastUsedAt || null }))
    .filter(
      (row) =>
        !favourites.has(row.entityId) &&
        cardArchiveCriteria.list().some((criterion) => {
          const amount = criteria[criterion.id]
          return amount !== undefined && criterion.matches(row, now, amount)
        })
    )
    .map(({ fromSource, userMessages, ...row }) => (fromSource === null ? row : { ...row, fromSource, userMessages }))
})
