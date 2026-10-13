import type { UserId } from "@rp/shared/domain.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { readSummary } from "./lcmReads.ts"

export const selectSummaryLayer = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string | null,
  partialBatch = false
) =>
  Effect.gen(function* () {
    const [any] = yield* sql<{
      present: number
    }>`SELECT EXISTS(SELECT 1 FROM summaries s JOIN chats c ON c.id = s.chat_id WHERE s.chat_id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND s.status IN ('complete', 'truncated')) AS present`
    if (!any?.present) return { summaries: [], cursor: null, cursorDepth: -1 }
    const candidates = yield* sql<{ id: string }>`WITH RECURSIVE path(id) AS (
      SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
    ) SELECT s.id FROM path JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
      WHERE s.chat_id = ${chatId} AND s.status IN ('complete', 'truncated')
        AND (${partialBatch ? 1 : 0} OR s.batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM summarization_jobs j INDEXED BY summarization_jobs_batch
          WHERE j.chat_id = s.chat_id AND j.batch_id = s.batch_id AND j.status IN ('pending', 'processing')))`

    const memo = new Map<string, Summary>()
    const ending = new Map<number, Array<Summary>>()
    for (const candidate of candidates) {
      const summary = yield* readSummary(sql, userId, candidate.id, undefined, memo)
      if (summary.to - summary.from + 1 !== summary.slotCount) continue
      const options = ending.get(summary.to) ?? []
      options.push(summary)
      ending.set(summary.to, options)
    }
    for (const options of ending.values())
      options.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.level - a.level || b.id.localeCompare(a.id))
    let selected: Array<Summary> = []
    let expected: number | undefined
    for (const [end, options] of [...ending].sort(([a], [b]) => b - a)) {
      if (expected !== undefined && end > expected) continue
      if (expected !== undefined && end < expected) selected = []
      const summary = options[0]!
      selected.unshift(summary)
      expected = summary.from - 1
    }
    if (expected !== 0) selected = []
    const newest = selected.at(-1)
    return { summaries: selected, cursor: newest?.lastSlotId ?? null, cursorDepth: newest ? newest.to - 1 : -1 }
  })
