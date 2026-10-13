import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import type { ContextSnapshot, WireContext } from "../assembler/types.ts"
import { prefixChange } from "../assembler/warmth.ts"
import { describer } from "./inspectorReads.ts"

/** A cache hit cannot extend a fixed lifetime established by the original write. */
export const cacheExpiry = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  last: {
    readonly started_at: number
    readonly cache_read: number | null
    readonly cache_write: number | null
    readonly model_id: string | null
  },
  previous: ContextSnapshot
) =>
  Effect.gen(function* () {
    let origin: number | null = last.started_at
    let originSnapshot = previous
    if ((last.cache_read ?? 0) > 0 && (last.cache_write ?? 0) === 0) {
      // Fixed-lived caches (Cerebras, OpenRouter explicit Gemini) do not slide
      // on a hit. Find the matching prefix's write/miss, never a newer unrelated one.
      const candidates = yield* sql<{ started_at: number; snapshot: string; sent: string | null }>`
            SELECT q.started_at, p.context_snapshot_json AS snapshot, p.sent_context_json AS sent
            FROM llm_requests q JOIN rollout_payloads p ON p.rollout_id = q.rollout_id
            WHERE q.chat_id = ${chatId} AND q.owner_user_id = ${userId} AND q.model_id = ${last.model_id}
              AND q.started_at <= ${last.started_at} AND q.status = 'complete' AND p.context_snapshot_json IS NOT NULL
              AND (q.cache_read = 0 OR q.cache_write > 0)
            ORDER BY q.started_at DESC, q.id DESC LIMIT 100`
      const descriptions = yield* describer(sql, userId, chatId as ChatId, [previous])
      let write: { startedAt: number; snapshot: ContextSnapshot } | undefined
      for (const row of candidates) {
        const snapshot = {
          ...(JSON.parse(row.snapshot) as ContextSnapshot),
          ...(row.sent ? { wire: JSON.parse(row.sent) as WireContext } : {})
        }
        if (prefixChange(snapshot, previous, descriptions) === null) {
          write = { startedAt: row.started_at, snapshot }
          break
        }
      }
      // A hit proves reuse, but without its original write time cannot date expiry.
      if (previous.wire?.cache?.fixed && !write) origin = null
      // A later transform can change the requested mode, but a hit cannot
      // rewrite the lifetime established by an earlier fixed-cache write.
      if (write && (previous.wire?.cache?.fixed || write.snapshot.wire?.cache?.fixed)) {
        origin = write.startedAt
        originSnapshot = write.snapshot
      }
    }
    const historicalTtl = originSnapshot.wire?.cache
      ? originSnapshot.wire.cache.ttlS
      : originSnapshot.inputs.model?.cacheTtlS
    return origin === null || historicalTtl == null ? null : origin + historicalTtl * 1000
  })
