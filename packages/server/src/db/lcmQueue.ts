import { uuidv7 } from "@rp/shared/id.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ContextSnapshot } from "../assembler/types.ts"
import { ownedModel } from "./generationSettings.ts"
import { jobColumns, type SummaryJob } from "./lcmJobs.ts"
import { lcmPath, slotInput } from "./lcmPath.ts"
import { NotFound, StorageError, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeLcmQueueHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const get = (userId: UserId, id: string, attempt?: number, includeDeleted = false) =>
    sql
      .unsafe<SummaryJob>(
        `SELECT ${jobColumns} FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id
      WHERE j.id = ? AND c.owner_user_id = ? AND (c.deleted_at IS NULL OR ?)
      AND (? IS NULL OR (j.status = 'processing' AND j.claim_epoch = ?))`,
        [id, userId, includeDeleted ? 1 : 0, attempt ?? null, attempt ?? null]
      )
      .pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "summary job", id }))
        )
      )
  const reject = (operation: string, message: string) => new StorageError({ operation, reason: "constraint", message })
  const close = (rolloutId: string | null, status: string, error: string | null) => sql`
    UPDATE rollouts SET status = ${status}, error = ${error}, completed_at = ${Date.now()}, updated_at = ${Date.now()},
      llm_requests = (SELECT count(*) FROM llm_requests WHERE rollout_id = ${rolloutId}),
      usage_input_tokens = (SELECT sum(input_uncached) FROM llm_requests WHERE rollout_id = ${rolloutId}),
      usage_output_tokens = (SELECT sum(output) FROM llm_requests WHERE rollout_id = ${rolloutId}),
      usage_cache_read_tokens = (SELECT sum(cache_read) FROM llm_requests WHERE rollout_id = ${rolloutId}),
      usage_cache_write_tokens = (SELECT sum(cache_write) FROM llm_requests WHERE rollout_id = ${rolloutId}),
      usage_cost = (SELECT sum(cost) FROM llm_requests WHERE rollout_id = ${rolloutId})
      WHERE id = ${rolloutId} AND status = 'running'`
  return {
    EnqueueSummaries: ({ userId, chatId, leafSlotId, chunks, requestClass }) =>
      Effect.gen(function* () {
        const path = yield* lcmPath(sql, userId, chatId, leafSlotId)
        const batchId = uuidv7(),
          now = Date.now(),
          result: SummaryJob[] = []
        for (const chunk of chunks) {
          const first = path.findIndex((s) => s.id === chunk.inputs[0]?.slotId)
          const chain = path.slice(first, first + chunk.inputs.length)
          if (
            first < 0 ||
            !chunk.inputs.length ||
            chunk.target <= 0 ||
            chain.some((s) => s.generating || s.merged) ||
            JSON.stringify(chain.map(slotInput)) !== JSON.stringify(chunk.inputs)
          )
            return yield* reject("EnqueueSummaries", "The summary chain or its inputs changed; plan again.")
          const pending = yield* sql<{
            first_slot_id: string
            last_slot_id: string
          }>`SELECT first_slot_id,last_slot_id FROM summarization_jobs WHERE chat_id = ${chatId} AND level = 1 AND status IN ('pending','processing')`
          const ids = new Set(chain.map((s) => s.id))
          let overlap = false
          for (const p of pending) {
            const other = yield* lcmPath(sql, userId, chatId, p.last_slot_id, p.first_slot_id)
            if (other.some((s) => ids.has(s.id))) {
              overlap = true
              break
            }
          }
          if (overlap) continue
          const id = uuidv7()
          yield* sql`INSERT INTO summarization_jobs ${sql.insert({
            id,
            chat_id: chatId,
            level: 1,
            first_slot_id: chain[0]!.id,
            last_slot_id: chain.at(-1)!.id,
            leaf_slot_id: leafSlotId,
            target_token_count: chunk.target,
            clip_tokens: chunk.clipTokens ?? 6000,
            batch_id: batchId,
            request_class: requestClass,
            created_at: now,
            updated_at: now
          })}`
          result.push(yield* get(userId, id))
        }
        return result
      }).pipe(transaction(sql, "EnqueueSummaries")),
    ClaimSummaryJob: ({ userId }) =>
      Effect.gen(function* () {
        const [next] = yield* sql<{ id: string }>`SELECT j.id FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id
        JOIN slots start ON start.id = j.first_slot_id
        WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND j.status = 'pending'
        AND (j.request_class = 'interactive' OR coalesce((SELECT json_extract(value_json,'$.spendAhead') FROM user_settings WHERE user_id = ${userId} AND key = 'generation.lcm'),1) <> 0)
        AND (SELECT count(*) FROM summarization_jobs busy JOIN chats bc ON bc.id = busy.chat_id
          WHERE bc.owner_user_id = ${userId} AND busy.status = 'processing') < 2
        AND (j.level > 1 OR NOT EXISTS (SELECT 1 FROM summarization_jobs busy JOIN slots bs ON bs.id = busy.first_slot_id
          WHERE busy.chat_id = j.chat_id AND busy.level = 1 AND
            (busy.status = 'processing' OR (busy.status = 'pending'
             AND (busy.request_class = 'interactive' OR coalesce((SELECT json_extract(value_json,'$.spendAhead') FROM user_settings WHERE user_id = ${userId} AND key = 'generation.lcm'),1) <> 0
               OR busy.last_slot_id IN (WITH RECURSIVE ancestors(id) AS (SELECT j.last_slot_id UNION ALL SELECT s.parent_slot_id FROM slots s JOIN ancestors a ON a.id=s.id WHERE s.parent_slot_id IS NOT NULL) SELECT id FROM ancestors))
             AND (bs.depth < start.depth OR (bs.depth = start.depth AND busy.id < j.id))))))
        ORDER BY CASE j.request_class WHEN 'interactive' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END, j.created_at, j.id LIMIT 1`
        if (!next) return null
        yield* sql`UPDATE summarization_jobs SET status = 'processing', attempts = attempts + 1, claim_epoch = claim_epoch + 1, rollout_id = NULL,
        updated_at = ${Date.now()} WHERE id = ${next.id} AND status = 'pending'`
        return yield* get(userId, next.id).pipe(Effect.orDie)
      }).pipe(transaction(sql, "ClaimSummaryJob")),
    StartSummaryRollout: ({ userId, jobId, attempt, rolloutId, snapshot }) =>
      Effect.gen(function* () {
        const j = yield* get(userId, jobId, attempt)
        const saved = JSON.parse(snapshot) as ContextSnapshot
        const model = saved.inputs.model
        if (
          !model ||
          saved.inputs.chatId !== j.chatId ||
          saved.summaryJob?.id !== jobId ||
          !(yield* ownedModel(sql, userId, model.connectionId, model.modelId))
        )
          return yield* new NotFound({ entity: "summary request", id: jobId })
        const [active] = yield* sql`SELECT id FROM summarization_jobs WHERE id = ${jobId} AND rollout_id IS NOT NULL`
        if (active) return yield* reject("StartSummaryRollout", "The attempt already has a rollout.")
        const now = Date.now()
        yield* sql`INSERT INTO rollouts ${sql.insert({
          id: rolloutId,
          chat_id: j.chatId,
          kind: j.level === 1 ? "summarize" : "condense",
          status: "running",
          leaf_slot_id: j.lastSlotId,
          role: "summarizer",
          connection_id: model.connectionId,
          model_id: model.modelId,
          request_class: j.requestClass,
          created_at: now,
          started_at: now,
          updated_at: now
        })}`
        yield* sql`INSERT INTO rollout_payloads ${sql.insert({ rollout_id: rolloutId, context_snapshot_json: snapshot })}`
        yield* sql`UPDATE summarization_jobs SET rollout_id = ${rolloutId} WHERE id = ${jobId}`
      }).pipe(transaction(sql, "StartSummaryRollout")),
    FailSummaryAttempt: ({ userId, jobId, attempt, rolloutId, error, draft }) =>
      Effect.gen(function* () {
        yield* get(userId, jobId, attempt, true)
        const [active] = yield* sql<{
          rollout_id: string | null
        }>`SELECT rollout_id FROM summarization_jobs WHERE id = ${jobId}`
        if (active!.rollout_id !== rolloutId)
          return yield* new NotFound({ entity: "summary rollout", id: rolloutId ?? "" })
        yield* close(rolloutId, "failed", error)
        yield* sql`UPDATE summarization_jobs SET status = CASE WHEN attempts <= max_retries THEN 'pending' ELSE 'failed' END,
        error = ${error}, best_effort_draft = ${draft ?? null}, rollout_id = NULL, updated_at = ${Date.now()} WHERE id = ${jobId}`
      }).pipe(transaction(sql, "FailSummaryAttempt")),
    ReleaseSummaryJob: ({ userId, jobId, attempt }) =>
      Effect.gen(function* () {
        yield* get(userId, jobId, attempt, true)
        const [active] = yield* sql<{
          rollout_id: string | null
        }>`SELECT rollout_id FROM summarization_jobs WHERE id = ${jobId}`
        yield* close(active!.rollout_id, "interrupted", null)
        yield* sql`UPDATE summarization_jobs SET status = 'pending', attempts = max(0,attempts-1), rollout_id = NULL,
        updated_at = ${Date.now()} WHERE id = ${jobId}`
      }).pipe(transaction(sql, "ReleaseSummaryJob")),
    ResetSummaryJobs: () =>
      Effect.gen(function* () {
        yield* sql`UPDATE rollouts SET status = 'interrupted', completed_at = ${Date.now()}, updated_at = ${Date.now()}
        WHERE status = 'running' AND id IN (SELECT rollout_id FROM summarization_jobs WHERE status = 'processing')`
        yield* sql`UPDATE summarization_jobs SET status = 'pending', attempts = max(0,attempts-1), rollout_id = NULL,
        updated_at = ${Date.now()} WHERE status = 'processing'`
        return yield* sql<{ userId: UserId; chatId: SummaryJob["chatId"]; leafSlotId: SummaryJob["leafSlotId"] }>`
        SELECT c.owner_user_id AS userId, c.id AS chatId, c.active_leaf_slot_id AS leafSlotId FROM chats c
        WHERE c.deleted_at IS NULL AND c.active_leaf_slot_id IS NOT NULL AND
          (EXISTS (SELECT 1 FROM summarization_jobs j WHERE j.chat_id = c.id AND j.status = 'pending') OR
           json_extract((SELECT value_json FROM state_events e WHERE e.chat_id = c.id AND e.key = 'lcm.settings'
             AND e.slot_id IS NULL ORDER BY e.seq DESC LIMIT 1),'$.enabled') = 1)`
      }).pipe(transaction(sql, "ResetSummaryJobs")),
    EscalateSummaryJob: ({ userId, jobId }) =>
      Effect.gen(function* () {
        yield* get(userId, jobId)
        yield* sql`UPDATE summarization_jobs SET request_class = 'interactive', updated_at = ${Date.now()}
        WHERE id = ${jobId} AND status IN ('pending','processing')`
      }).pipe(transaction(sql, "EscalateSummaryJob"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
