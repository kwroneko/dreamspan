// The backfill of a chat that LCM was enabled on (spec/LCM.md §2.11): a `jobs` row of kind
// `lcm-backfill` holding what the user approved, and the rules that stop summarizing at 150% of
// it until they continue. Spending is read from the usage ledger: the summarization requests
// attributed to the chat since the user approved. The row says nothing about progress; what is
// left is estimated again from the chat when it is shown.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const BACKFILL_KIND = "lcm-backfill"

/** Where spending stops, as a share of what the user approved. */
const CAP_SHARE = 1.5

export interface BackfillPayload {
  readonly chatId: string
  readonly leafSlotId: string
  readonly choice: "adopt" | "scratch"
  readonly startedAt: number
  /** Enabled, and waiting for the next reply or "Summarize now" to begin. */
  readonly armed: boolean
  readonly paused: boolean
  readonly capped: boolean
  /** "Summarize now" was pressed: the work goes on without waiting for each reply. */
  readonly drive: boolean
  /** Billed tokens (input, cache and output) and money approved for the work. */
  readonly approvedTokens: number
  readonly approvedCost: number | null
  readonly currency: string | null
  /** Where spending since `startedAt` stops, in the same measures. */
  readonly capTokens: number
  readonly capCost: number | null
}

export interface BackfillRow extends BackfillPayload {
  readonly id: string
  readonly ownerUserId: string
  readonly status: "processing" | "complete"
}

interface Raw {
  readonly id: string
  readonly owner_user_id: string
  readonly status: "processing" | "complete" | "pending" | "failed"
  readonly payload_json: string
}

const rowOf = (raw: Raw): BackfillRow => ({
  ...(JSON.parse(raw.payload_json) as BackfillPayload),
  id: raw.id,
  ownerUserId: raw.owner_user_id,
  status: raw.status === "complete" ? "complete" : "processing"
})

/**
 * The chat's newest backfill, live or done; null when it never had one. The kind is written out
 * in the SQL: a partial index (`jobs_lcm_backfill`) is used only when the query names its kind.
 */
export const backfillOf = (sql: SqlClient.SqlClient, chatId: string) =>
  sql<Raw>`SELECT id, owner_user_id, status, payload_json FROM jobs
    WHERE kind = 'lcm-backfill' AND json_extract(payload_json, '$.chatId') = ${chatId}
    ORDER BY created_at DESC, id DESC LIMIT 1`.pipe(Effect.map(([raw]) => (raw ? rowOf(raw) : null)))

/** What the summarization requests of a chat have used since a time: billed tokens, and money when priced. */
export const spentSince = (sql: SqlClient.SqlClient, chatId: string, since: number) =>
  sql<{ tokens: number; cost: number | null; currency: string | null }>`
    SELECT coalesce(sum(coalesce(input_uncached, 0) + coalesce(cache_read, 0) + coalesce(cache_write, 0) + coalesce(output, 0)), 0) AS tokens,
      sum(cost) AS cost, max(cost_currency) AS currency
    FROM llm_requests WHERE chat_id = ${chatId} AND purpose IN ('summarize', 'condense')
      AND started_at >= ${since} AND status <> 'running'`.pipe(Effect.map(([row]) => row!))

/** Whether the spending has reached the cap, by tokens or, when both are known, by money. */
export const overCap = (row: BackfillPayload, spent: { tokens: number; cost: number | null }) =>
  spent.tokens >= row.capTokens || (row.capCost !== null && spent.cost !== null && spent.cost >= row.capCost)

/** A cap of 150% of `approved`, counted from what has been spent. */
export const capFor = (
  approved: { readonly tokens: number; readonly cost: number | null },
  spent: { readonly tokens: number; readonly cost: number | null }
) => ({
  capTokens: spent.tokens + Math.ceil(approved.tokens * CAP_SHARE),
  capCost: approved.cost === null ? null : (spent.cost ?? 0) + approved.cost * CAP_SHARE
})

/**
 * Stops the live backfills of a user's chats that have reached their caps. Run before jobs are
 * claimed, so a cap holds however the work was started; a chat stays stopped until Continue.
 */
export const enforceCaps = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.gen(function* () {
    const live = yield* sql<Raw>`SELECT id, owner_user_id, status, payload_json FROM jobs
      WHERE kind = ${BACKFILL_KIND} AND status = 'processing' AND owner_user_id = ${userId}`
    for (const raw of live) {
      const row = rowOf(raw)
      if (row.capped || row.paused) continue
      if (!overCap(row, yield* spentSince(sql, row.chatId, row.startedAt))) continue
      const { id: _id, ownerUserId: _owner, status: _status, ...payload } = row
      yield* sql`UPDATE jobs SET payload_json = ${JSON.stringify({ ...payload, capped: true })}, updated_at = ${Date.now()}
        WHERE id = ${row.id}`
    }
  })

/** Whether claims of this chat's jobs are held: its live backfill is paused or has reached its cap. */
export const heldSql = (chatColumn: string) => `EXISTS (SELECT 1 FROM jobs bf WHERE bf.kind = '${BACKFILL_KIND}'
  AND bf.status = 'processing' AND json_extract(bf.payload_json, '$.chatId') = ${chatColumn}
  AND (json_extract(bf.payload_json, '$.paused') = 1 OR json_extract(bf.payload_json, '$.capped') = 1))`

/** Whether the user pressed "Summarize now" on this chat's live backfill, which lets its jobs run beyond `spendAhead`. */
export const drivenSql = (chatColumn: string) => `EXISTS (SELECT 1 FROM jobs bf WHERE bf.kind = '${BACKFILL_KIND}'
  AND bf.status = 'processing' AND json_extract(bf.payload_json, '$.chatId') = ${chatColumn}
  AND json_extract(bf.payload_json, '$.drive') = 1)`
