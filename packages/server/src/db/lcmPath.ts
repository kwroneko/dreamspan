import { contextExcluded } from "./lcmVisibility.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { Summary } from "@rp/shared/lcm.ts"

export interface LcmSlot {
  id: Summary["firstSlotId"]
  parent: string | null
  depth: number
  content: string
  versionId: Summary["inputs"][number]["versionId"]
  amendCount: number
  generating: number
  merged: number
  children: number
}
/**
 * The slots from `first` (or the root) to `leaf`, oldest first. `limit` stops the walk after that
 * many slots, so asking for a range that isn't a chain can't read a whole path.
 */
export const lcmPath = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string,
  first?: string,
  limit = Number.MAX_SAFE_INTEGER
) =>
  Effect.gen(function* () {
    const [owned] = yield* sql`SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
    if (!owned) return yield* new NotFound({ entity: "chat path", id: leaf })
    return yield* sql<LcmSlot>`WITH RECURSIVE path AS (
      SELECT id, parent_slot_id, depth, 1 AS n FROM slots WHERE id = ${leaf}
      UNION ALL SELECT s.id, s.parent_slot_id, s.depth, p.n + 1 FROM slots s JOIN path p ON s.id = p.parent_slot_id
        WHERE p.id IS NOT ${first ?? null} AND p.n < ${limit}
    ) SELECT p.id, p.parent_slot_id AS parent, p.depth,
      CASE WHEN s.deleted_at IS NULL AND s.purged_at IS NULL AND ${sql.literal(contextExcluded())} = 0
        AND v.deleted_at IS NULL AND v.purged_at IS NULL AND v.status NOT IN ('generating','failed') AND length(v.content) > 0 THEN v.id END AS versionId,
      CASE WHEN s.deleted_at IS NULL AND s.purged_at IS NULL AND ${sql.literal(contextExcluded())} = 0
        AND v.deleted_at IS NULL AND v.purged_at IS NULL AND v.status NOT IN ('generating','failed') THEN coalesce(v.content,'') ELSE '' END AS content,
      (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS amendCount,
      coalesce(v.status = 'generating',0) AS generating,
      EXISTS(SELECT 1 FROM slot_parents m WHERE m.slot_id = p.id) AS merged,
      (SELECT count(*) FROM slots child WHERE child.parent_slot_id = p.id AND child.deleted_at IS NULL) AS children
      FROM path p JOIN slots s ON s.id = p.id LEFT JOIN versions v ON v.id = s.selected_version_id ORDER BY p.depth`
  })
export const slotInput = (s: LcmSlot): Summary["inputs"][number] => ({
  slotId: s.id,
  versionId: s.versionId,
  amendCount: s.versionId ? s.amendCount : 0
})
