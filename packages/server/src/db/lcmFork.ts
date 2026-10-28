// Summary material is shared; choices and requests use the same frozen lineage as messages.
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { effectiveOverride, inFork, viewAt, writeOverride } from "./forkState.ts"
import { NotFound } from "./ops.ts"

export const inSummaryFork =
  (sql: SqlClient.SqlClient, userId: UserId, summaryId: string, forkId?: string | null) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ chat_id: string; last_slot_id: string }>`SELECT s.chat_id,s.last_slot_id
      FROM summaries s JOIN chats c ON c.id=s.chat_id WHERE s.id=${summaryId}
      AND c.owner_user_id=${userId} AND c.deleted_at IS NULL`
      if (!row) return yield* new NotFound({ entity: "summary", id: summaryId })
      return yield* effect.pipe(inFork(sql, row.chat_id, forkId, null))
    })

export const inJobFork =
  (sql: SqlClient.SqlClient, jobId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const [job] = yield* sql<{
        chat_id: string
        fork_id: string | null
        last_slot_id: string
      }>`SELECT chat_id,fork_id,last_slot_id FROM summarization_jobs WHERE id=${jobId}`
      if (!job) return yield* new NotFound({ entity: "summary job", id: jobId })
      return yield* effect.pipe(inFork(sql, job.chat_id, job.fork_id, null))
    })

export const summaryChoices = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.gen(function* () {
    const fork = yield* viewAt(sql, chatId, null)
    return yield* sql<{ summary_id: string; chosen_id: string }>`SELECT s.id AS summary_id,
    coalesce(o.value_id,b.chosen_id,s.id) AS chosen_id FROM summaries s
    LEFT JOIN fork_overrides o ON o.id=${effectiveOverride(sql, "summary_choice", fork, "s.id")}
    LEFT JOIN lcm_summary_choices b ON b.summary_id=s.id WHERE s.chat_id=${chatId} AND (o.id IS NOT NULL OR b.summary_id IS NOT NULL)`
  })

export const rerunRequests = (sql: SqlClient.SqlClient, chatId: string) =>
  Effect.gen(function* () {
    const fork = yield* viewAt(sql, chatId, null)
    return yield* sql<{ id: string; summary_id: string | null; job_id: string | null; model_json: string | null }>`
    SELECT r.id,r.summary_id,r.job_id,r.model_json FROM summary_reruns r
    JOIN fork_overrides o ON o.value_id=r.id AND o.kind='summary_rerun'
      AND o.id=${effectiveOverride(sql, "summary_rerun", fork, "coalesce(r.summary_id,r.job_id)")}
    WHERE r.chat_id=${chatId} AND o.flag=1`
  })

export const withdrawReruns = (sql: SqlClient.SqlClient, chatId: string, ids: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    if (!ids?.length) return
    const fork = yield* viewAt(sql, chatId, null)
    for (const request of yield* rerunRequests(sql, chatId)) {
      if (!ids.includes(request.id)) continue
      yield* writeOverride(
        sql,
        { id: fork!, chatId },
        { kind: "summary_rerun", targetId: request.summary_id ?? request.job_id!, slotId: null, valueId: null, flag: 0 }
      )
    }
  })
