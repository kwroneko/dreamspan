import { cacheExpiry } from "./cacheExpiry.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ContextSnapshot, WireContext } from "../assembler/types.ts"
import { wireContext, wireDigest } from "../assembler/wire.ts"
import type { SummaryPrefix } from "../lcm/prefix.ts"

/** Admission compares the pinned request, not a newly expanded hypothetical reply. */
export const summaryIsWarm = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  next: Pick<SummaryPrefix, "inputs" | "request"> | null
) =>
  Effect.gen(function* () {
    if (!next?.inputs.model || !next.request.messages.length) return false
    const [last] = yield* sql<{
      started_at: number
      snapshot: string | null
      sent: string | null
      cache_read: number | null
      cache_write: number | null
      model_id: string | null
    }>`
    SELECT q.started_at,q.cache_read,q.cache_write,q.model_id,p.context_snapshot_json AS snapshot,p.sent_context_json AS sent
    FROM llm_requests q JOIN rollout_payloads p ON p.rollout_id=q.rollout_id
    WHERE q.chat_id=${chatId} AND q.owner_user_id=${userId}
      AND (q.status IN ('running','complete') OR q.first_token_at IS NOT NULL)
    ORDER BY q.started_at DESC,q.id DESC LIMIT 1`
    if (!last?.snapshot) return false
    const previous: ContextSnapshot = {
        ...JSON.parse(last.snapshot),
        ...(last.sent ? { wire: JSON.parse(last.sent) as WireContext } : {})
      },
      before = previous.inputs.model,
      after = next.inputs.model
    if (
      !before ||
      before.connectionId !== after.connectionId ||
      before.connectionRevision !== after.connectionRevision ||
      before.modelId !== after.modelId ||
      before.key !== after.key ||
      before.api !== after.api ||
      before.mapping?.revision !== after.mapping?.revision
    )
      return false
    const expiresAt = yield* cacheExpiry(sql, userId, chatId, last, previous)
    if (expiresAt === null || expiresAt <= Date.now()) return false
    const old = (last.sent ? (JSON.parse(last.sent) as WireContext) : wireContext(previous.request, before)).messages
    const end = Math.max(-1, ...next.request.breakpoints.filter((b) => b.reason !== "history").map((b) => b.message))
    if (end < 0) return false
    const mapped = wireContext(next.request, after).messages
    const prefix = mapped.slice(0, mapped.findLastIndex((m) => m.inputs.some((i) => i <= end)) + 1)
    return (
      prefix.length > 0 &&
      prefix.every((m, i) => old[i] && (old[i]!.digest ?? wireDigest(old[i]!)) === (m.digest ?? wireDigest(m)))
    )
  })
