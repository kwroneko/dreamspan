// Full-folder arrival evidence is separate from edit times. Metadata beats chat evidence,
// then file times, then import time; repeated evidence of one kind keeps its earliest date.
import type { StArrival } from "@dreamspan/shared/stImportApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const recordCardArrival = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  refId: string,
  arrival: StArrival
) {
  yield* sql`UPDATE entity_refs SET created_at = ${arrival.at}, st_added_basis = ${arrival.basis}
    WHERE id = ${refId}
      AND EXISTS (SELECT 1 FROM entities e WHERE e.id = entity_refs.entity_id
        AND e.owner_user_id = ${userId} AND e.kind = 'card')
      AND (st_added_basis IS NULL OR st_added_basis > ${arrival.basis}
        OR (st_added_basis = ${arrival.basis} AND created_at > ${arrival.at}))`
  // Newly discovered author metadata can refine Created on a re-import too. Without it,
  // arrival remains the earliest evidence of making. This never changes a manual import.
  yield* sql`UPDATE entities SET created_at = (
      SELECT CASE WHEN coalesce(json_type(h.doc_json, '$.creation_date') IN ('integer','real'), 0)
          AND json_extract(h.doc_json, '$.creation_date') > 0
          AND json_extract(h.doc_json, '$.creation_date') <= 8640000000000
        THEN CAST(json_extract(h.doc_json, '$.creation_date') * 1000 AS INTEGER) ELSE r.created_at END
      FROM entity_refs r JOIN entity_revisions h ON h.id = r.head_revision_id WHERE r.id = ${refId})
    WHERE owner_user_id = ${userId} AND kind = 'card'
      AND id IN (SELECT entity_id FROM entity_refs WHERE id = ${refId} AND st_added_basis IS NOT NULL)`
})

export const recordChatArrival = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  chatId: string,
  arrival: StArrival
) {
  const [chat] = yield* sql<{ st_group_id: string | null }>`SELECT st_group_id FROM chats
    WHERE id = ${chatId} AND owner_user_id = ${userId}`
  if (chat === undefined) return
  const where =
    chat.st_group_id === null
      ? sql`id = ${chatId} AND owner_user_id = ${userId}`
      : sql`owner_user_id = ${userId} AND st_group_id IS NOT NULL AND st_group_id = ${chat.st_group_id}`
  const [best] = yield* sql<{ added_at: number; st_added_basis: number }>`SELECT added_at, st_added_basis FROM chats
    WHERE ${where} AND st_added_basis IS NOT NULL ORDER BY st_added_basis, added_at LIMIT 1`
  const chosen =
    best !== undefined &&
    (best.st_added_basis < arrival.basis || (best.st_added_basis === arrival.basis && best.added_at < arrival.at))
      ? { at: best.added_at, basis: best.st_added_basis }
      : arrival
  yield* sql`UPDATE chats SET added_at = ${chosen.at}, st_added_basis = ${chosen.basis}
    WHERE ${where} AND (st_added_basis IS NULL OR st_added_basis > ${chosen.basis}
      OR (st_added_basis = ${chosen.basis} AND added_at > ${chosen.at}))`
})
