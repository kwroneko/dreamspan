import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { lineageValidator } from "./lcmLayer.ts"
import { readSummary } from "./lcmReads.ts"
import { type LcmSlot } from "./lcmPath.ts"

/** Completed work remains coverage even when a failed earlier chunk blocks selection. */
export const completedCoverage = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, path: readonly LcmSlot[]) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ id: string; first_slot_id: string; last_slot_id: string; slot_count: number }>`
      SELECT s.id,s.first_slot_id,s.last_slot_id,s.slot_count FROM summaries s JOIN chats c ON c.id=s.chat_id
      WHERE s.chat_id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
        AND s.level=1 AND s.sealed=1 AND s.status IN ('complete','truncated')`
    const valid = lineageValidator(sql, userId),
      covered = new Set<string>()
    for (const row of rows) {
      const first = path.findIndex((s) => s.id === row.first_slot_id)
      if (first < 0 || !(yield* valid(row.id))) continue
      const chain = path.slice(first, first + row.slot_count)
      if (chain.length !== row.slot_count || chain.at(-1)?.id !== row.last_slot_id) continue
      if ((yield* readSummary(sql, userId, row.id)).fresh) for (const slot of chain) covered.add(slot.id)
    }
    return covered
  })

/**
 * Slots of a range whose summary failed and whose inputs have not changed since: the planner
 * leaves them alone until Retry, or until an edit or swipe inside the range makes the failure
 * stale (spec/LCM.md §2.8).
 */
export const failedHold = (sql: SqlClient.SqlClient, userId: UserId, chatId: string, path: readonly LcmSlot[]) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ id: string; first_slot_id: string; last_slot_id: string; slot_count: number }>`
      SELECT s.id,s.first_slot_id,s.last_slot_id,s.slot_count FROM summaries s JOIN chats c ON c.id=s.chat_id
      WHERE s.chat_id=${chatId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL
        AND s.level=1 AND s.sealed=1 AND s.status='failed'`
    const valid = lineageValidator(sql, userId),
      held = new Set<string>()
    for (const row of rows) {
      const first = path.findIndex((s) => s.id === row.first_slot_id)
      if (first < 0 || path.length < first + row.slot_count || !(yield* valid(row.id))) continue
      if (path[first + row.slot_count - 1]?.id !== row.last_slot_id) continue
      if (!(yield* readSummary(sql, userId, row.id)).fresh) continue
      for (const slot of path.slice(first, first + row.slot_count)) held.add(slot.id)
    }
    return held
  })
