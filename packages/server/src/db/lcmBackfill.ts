import { viewAt } from "./forkState.ts"
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
  readonly forkId?: string | null
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
export const backfillOf = (sql: SqlClient.SqlClient, chatId: string, forkId?: string | null) =>
  Effect.gen(function* () {
    const fork = forkId ?? (yield* viewAt(sql, chatId, null))
    const [raw] = yield* sql<Raw>`SELECT id,owner_user_id,status,payload_json FROM jobs
    WHERE kind='lcm-backfill' AND json_extract(payload_json,'$.chatId')=${chatId}
      AND coalesce(json_extract(payload_json,'$.forkId'),(SELECT current_fork_id FROM chats WHERE id=${chatId})) IS ${fork}
    ORDER BY created_at DESC,id DESC LIMIT 1`
    return raw ? rowOf(raw) : null
  })

/** Summary rollouts include their judge requests, but never narrator decisions. Interrupted or
 * unreported requests retain their reservation: a restart cannot prove they were free. */
export const spentSince = (sql: SqlClient.SqlClient, chatId: string, since: number, forkId?: string | null) =>
  sql<{ tokens: number; cost: number | null; currency: string | null }>`
    SELECT coalesce(sum(CASE WHEN reserved_tokens IS NOT NULL AND usage_source IS NOT 'reported' THEN reserved_tokens
      ELSE coalesce(input_uncached, 0) + coalesce(cache_read, 0) + coalesce(cache_write, 0) + coalesce(output, 0) END), 0) AS tokens,
      sum(CASE WHEN reserved_cost IS NOT NULL AND usage_source IS NOT 'reported' THEN reserved_cost ELSE coalesce(cost, reserved_cost) END) AS cost, max(coalesce(cost_currency, reserved_currency)) AS currency
    FROM llm_requests WHERE chat_id = ${chatId} AND started_at >= ${since}
      AND (${forkId ?? null} IS NULL OR EXISTS(SELECT 1 FROM rollouts fr WHERE fr.id=llm_requests.rollout_id AND (fr.fork_id IS NULL OR fr.fork_id=${forkId ?? null}))) AND status <> 'running'
      AND (purpose IN ('summarize', 'condense') OR (purpose = 'decision' AND EXISTS (
        SELECT 1 FROM rollouts r WHERE r.id = llm_requests.rollout_id AND r.kind IN ('summarize', 'condense'))))`.pipe(
    Effect.map(([row]) => row!)
  )

/** Admission and reservation happen in OpenLlmRequest's transaction, shared by every dispatch. */
export const admitRequest = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  userId: string,
  request: {
    chatId: string | null
    rolloutId: string | null
    purpose: string
    reservation?: { tokens: number; cost: number | null; currency: string | null }
  }
) {
  if (!request.chatId) return { allowed: true, backfillId: null }
  const related =
    request.purpose === "summarize" ||
    request.purpose === "condense" ||
    (request.purpose === "decision" &&
      request.rolloutId &&
      (yield* sql`SELECT 1 FROM rollouts WHERE id = ${request.rolloutId} AND kind IN ('summarize', 'condense')`)
        .length > 0)
  if (!related) return { allowed: true, backfillId: null }
  const [rollout] = yield* sql<{ fork_id: string | null }>`SELECT fork_id FROM rollouts WHERE id=${request.rolloutId}`
  const row = yield* backfillOf(sql, request.chatId, rollout?.fork_id)
  if (!row || row.status === "complete" || row.ownerUserId !== userId) return { allowed: true, backfillId: null }
  if (row.paused || row.capped) return { allowed: false, backfillId: row.id }
  const spent = yield* spentSince(sql, row.chatId, row.startedAt, row.forkId)
  const [pending] = yield* sql<{ tokens: number; cost: number }>`SELECT coalesce(sum(reserved_tokens), 0) AS tokens,
    coalesce(sum(reserved_cost), 0) AS cost FROM llm_requests WHERE backfill_id = ${row.id} AND status = 'running'`
  const bound = request.reservation
  if (
    !bound ||
    spent.tokens + pending!.tokens + bound.tokens > row.capTokens ||
    (row.capCost !== null &&
      (bound.cost === null ||
        bound.currency !== row.currency ||
        (spent.cost ?? 0) + pending!.cost + bound.cost > row.capCost))
  ) {
    const { id, ownerUserId: _owner, status: _status, ...payload } = row
    yield* sql`UPDATE jobs SET payload_json = ${JSON.stringify({ ...payload, capped: true })}, updated_at = ${Date.now()} WHERE id = ${id}`
    return { allowed: false, backfillId: row.id }
  }
  return { allowed: true, backfillId: row.id }
})

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
      if (!overCap(row, yield* spentSince(sql, row.chatId, row.startedAt, row.forkId))) continue
      const { id: _id, ownerUserId: _owner, status: _status, ...payload } = row
      yield* sql`UPDATE jobs SET payload_json = ${JSON.stringify({ ...payload, capped: true })}, updated_at = ${Date.now()}
        WHERE id = ${row.id}`
    }
  })

/** Whether claims of this chat's jobs are held: its live backfill is paused or has reached its cap. */
export const heldSql = (
  chatColumn: string,
  forkColumn: string
) => `EXISTS (SELECT 1 FROM jobs bf WHERE bf.kind = '${BACKFILL_KIND}'
  AND bf.status = 'processing' AND json_extract(bf.payload_json, '$.chatId') = ${chatColumn}
  AND coalesce(json_extract(bf.payload_json,'$.forkId'),(SELECT current_fork_id FROM chats WHERE id=${chatColumn})) IS coalesce(${forkColumn},(SELECT current_fork_id FROM chats WHERE id=${chatColumn}))
  AND (json_extract(bf.payload_json, '$.paused') = 1 OR json_extract(bf.payload_json, '$.capped') = 1))`

/** Whether the user pressed "Summarize now" on this chat's live backfill, which lets its jobs run beyond `spendAhead`. */
export const drivenSql = (
  chatColumn: string,
  forkColumn: string
) => `EXISTS (SELECT 1 FROM jobs bf WHERE bf.kind = '${BACKFILL_KIND}'
  AND bf.status = 'processing' AND json_extract(bf.payload_json, '$.chatId') = ${chatColumn}
  AND coalesce(json_extract(bf.payload_json,'$.forkId'),(SELECT current_fork_id FROM chats WHERE id=${chatColumn})) IS coalesce(${forkColumn},(SELECT current_fork_id FROM chats WHERE id=${chatColumn}))
  AND json_extract(bf.payload_json, '$.drive') = 1)`
