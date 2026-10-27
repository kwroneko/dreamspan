// Shared named notes (DESIGN §4.1): note entities with `owner: { shared: "global" }`, the text
// a note slot can link to. Queries both workers use.
import type { EntityId } from "@rp/shared/chat.ts"
import type { LinkedNote } from "@rp/shared/chatSetupApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

/** How many live note slots' library heads link to each of `entities`. */
export const linkCounts = (sql: SqlClient.SqlClient, userId: UserId, entities: ReadonlyArray<string>) =>
  sql<{ link: string; n: number }>`
    SELECT json_extract(h.doc_json, '$.link') AS link, count(*) AS n
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
    JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL
      AND json_extract(h.doc_json, '$.link') IN (SELECT value FROM json_each(${JSON.stringify(entities)}))
    GROUP BY 1`.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.link, row.n]))))

/**
 * A shared note of the user's by its entity: its upstream ref and head, binned or not (a
 * purged one is gone). Null when it isn't one: another user's, another kind, a card's note.
 */
export const sharedNote = (sql: SqlClient.SqlClient, userId: UserId, entityId: string) =>
  sql<{ ref_id: string; head: string; title: string; content: string; deleted: number }>`
    SELECT r.id AS ref_id, r.head_revision_id AS head, json_extract(h.doc_json, '$.title') AS title,
      json_extract(h.doc_json, '$.content') AS content, e.deleted_at IS NOT NULL AS deleted
    FROM entities e JOIN entity_refs r ON r.entity_id = e.id AND r.ref_kind = 'upstream'
    JOIN entity_revisions h ON h.id = r.head_revision_id
    WHERE e.id = ${entityId} AND e.owner_user_id = ${userId} AND e.kind = 'note' AND e.purged_at IS NULL
      AND json_extract(h.doc_json, '$.owner.shared') IS NOT NULL`.pipe(Effect.map(([row]) => row ?? null))

/** The shared note a slot links to, as a chat's note list shows it; null when it's gone. */
export const linkedNote = (sql: SqlClient.SqlClient, userId: UserId, entityId: string) =>
  Effect.gen(function* () {
    const shared = yield* sharedNote(sql, userId, entityId)
    if (shared === null) return null
    const counts = yield* linkCounts(sql, userId, [entityId])
    return {
      refId: shared.ref_id as RefId,
      entityId: entityId as EntityId,
      title: shared.title,
      binned: shared.deleted === 1,
      usedBy: counts.get(entityId) ?? 0
    } satisfies LinkedNote
  })
