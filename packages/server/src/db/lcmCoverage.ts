import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { lineageValidator } from "./lcmLayer.ts"
import { slotInput, type LcmSlot } from "./lcmPath.ts"

/** Completed work remains coverage even when a failed earlier chunk blocks selection. */
export const completedCoverage = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, path: readonly LcmSlot[]) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ id: string; first_slot_id: string; slot_count: number }>`
      SELECT s.id,s.first_slot_id,s.slot_count FROM summaries s JOIN chats c ON c.id=s.chat_id
      WHERE s.chat_id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
        AND s.level=1 AND s.sealed=1 AND s.status IN ('complete','truncated')`
    const valid = lineageValidator(sql, userId),
      covered = new Set<string>()
    for (const row of rows) {
      const first = path.findIndex((s) => s.id === row.first_slot_id)
      if (first < 0 || !(yield* valid(row.id))) continue
      const inputs = yield* sql<{ slotId: string; versionId: string | null; amendCount: number }>`
        SELECT slot_id AS slotId,version_id AS versionId,amend_count AS amendCount
        FROM summary_inputs WHERE summary_id=${row.id} ORDER BY ordinal`
      const chain = path.slice(first, first + row.slot_count)
      if (JSON.stringify(inputs) === JSON.stringify(chain.map(slotInput)))
        for (const slot of chain) covered.add(slot.id)
    }
    return covered
  })
