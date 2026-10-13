import { summaryIsWarm } from "./lcmWarmth.ts"
import type { SummaryPrefix } from "../lcm/prefix.ts"
import { takeSummaryPrefix } from "../lcm/prefix.ts"
import { completedCoverage } from "./lcmCoverage.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ContextSnapshot } from "../assembler/types.ts"
import { ownedModel } from "./generationSettings.ts"
import { fallbackModel, type JobError, prefixAt, recordFailedSummary, targetFor } from "./lcmFailures.ts"
import { readSummary } from "./lcmReads.ts"
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
    EnqueueSummaries: ({ userId, chatId, leafSlotId, chunks, requestClass, triggerVersionId }) =>
      Effect.gen(function* () {
        const path = yield* lcmPath(sql, userId, chatId, leafSlotId)
        if (triggerVersionId) {
          const [version] = yield* sql<{
            slot_id: string
          }>`SELECT v.slot_id FROM versions v JOIN slots s ON s.id=v.slot_id
            WHERE v.id=${triggerVersionId} AND s.chat_id=${chatId}`
          if (!version || !path.some((s) => s.id === version.slot_id))
            return yield* new NotFound({ entity: "summary trigger", id: triggerVersionId })
        }
        const covered = yield* completedCoverage(sql, userId, chatId, path)
        const [origin] = yield* sql<{ snapshot: string }>`WITH RECURSIVE path(id) AS (
          SELECT ${leafSlotId} UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id=s.id WHERE s.parent_slot_id IS NOT NULL
        ) SELECT p.context_snapshot_json AS snapshot FROM path a JOIN slots s ON s.id=a.id
          JOIN versions v ON v.id=coalesce(${triggerVersionId ?? null},s.selected_version_id) AND v.slot_id=s.id JOIN rollouts r ON r.id=v.rollout_id
          JOIN rollout_payloads p ON p.rollout_id=r.id WHERE r.chat_id=${chatId} AND r.kind='generation'
          AND p.context_snapshot_json IS NOT NULL ORDER BY s.depth DESC LIMIT 1`
        const prefix = origin ? JSON.stringify(takeSummaryPrefix(JSON.parse(origin.snapshot) as ContextSnapshot)) : null
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
          if (chain.some((s) => covered.has(s.id))) continue
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
            prefix_json: prefix,
            batch_id: batchId,
            request_class: requestClass,
            created_at: now,
            updated_at: now
          })}`
          result.push(yield* get(userId, id))
        }
        return result
      }).pipe(transaction(sql, "EnqueueSummaries")),
    ReconcileSummaryJobs: ({ userId, running }) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string; claim_epoch: number; rollout_id: string | null }>`
          SELECT j.id,j.claim_epoch,j.rollout_id FROM summarization_jobs j JOIN chats c ON c.id=j.chat_id
          WHERE c.owner_user_id=${userId} AND j.status='processing'`
        for (const row of rows) {
          if (running.some((r) => r.id === row.id && r.epoch === row.claim_epoch)) continue
          yield* close(row.rollout_id, "interrupted", null)
          yield* sql`UPDATE summarization_jobs SET status='pending', attempts=max(0,attempts-1), rollout_id=NULL,
            updated_at=${Date.now()} WHERE id=${row.id}`
        }
      }).pipe(transaction(sql, "ReconcileSummaryJobs")),
    ClaimSummaryJob: ({ userId }) =>
      Effect.gen(function* () {
        const idle = yield* sql<{ id: string; chat_id: string; prefix_json: string | null }>`
          SELECT j.id,j.chat_id,j.prefix_json FROM summarization_jobs j JOIN chats c ON c.id=j.chat_id
          WHERE c.owner_user_id=${userId} AND c.deleted_at IS NULL AND j.status='pending' AND j.request_class='idle'`
        for (const job of idle)
          if (
            !(yield* summaryIsWarm(
              sql,
              userId,
              job.chat_id,
              job.prefix_json ? (JSON.parse(job.prefix_json) as SummaryPrefix) : null
            ))
          )
            yield* sql`UPDATE summarization_jobs SET request_class='background' WHERE id=${job.id}`
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
        const requestClass =
          j.requestClass === "idle" && !(yield* summaryIsWarm(sql, userId, j.chatId, saved))
            ? "background"
            : j.requestClass
        if (requestClass !== j.requestClass)
          yield* sql`UPDATE summarization_jobs SET request_class=${requestClass} WHERE id=${jobId}`
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
          request_class: requestClass,
          created_at: now,
          started_at: now,
          updated_at: now
        })}`
        yield* sql`INSERT INTO rollout_payloads ${sql.insert({ rollout_id: rolloutId, context_snapshot_json: snapshot })}`
        yield* sql`UPDATE summarization_jobs SET rollout_id = ${rolloutId} WHERE id = ${jobId}`
      }).pipe(transaction(sql, "StartSummaryRollout")),
    FailSummaryAttempt: ({ userId, jobId, attempt, rolloutId, error, errorClass, errorKind, errorCategory, draft }) =>
      Effect.gen(function* () {
        yield* get(userId, jobId, attempt, true)
        const [active] = yield* sql<{
          rollout_id: string | null
        }>`SELECT rollout_id FROM summarization_jobs WHERE id = ${jobId}`
        if (active!.rollout_id !== rolloutId)
          return yield* new NotFound({ entity: "summary rollout", id: rolloutId ?? "" })
        const failure: JobError = {
          class: errorClass ?? "unknown",
          message: error,
          ...(errorKind ? { kind: errorKind } : {}),
          ...(errorCategory ? { category: errorCategory } : {})
        }
        yield* close(rolloutId, "failed", error)
        const [job] = yield* sql<{
          id: string
          chat_id: string
          level: number
          first_slot_id: string
          last_slot_id: string
          batch_id: string | null
          input_child_ids: string | null
          attempts: number
          max_retries: number
          fallback_used: number
          model_json: string | null
        }>`SELECT * FROM summarization_jobs WHERE id = ${jobId}`
        const now = Date.now()
        // The summarizer's own model gets its retries; the fallback model, if the user set one, gets one more attempt.
        const retry = job!.attempts <= job!.max_retries
        const fallback = !retry && job!.fallback_used === 0 ? yield* fallbackModel(sql, userId) : null
        if (retry || fallback) {
          yield* sql`UPDATE summarization_jobs SET status = 'pending', error = ${JSON.stringify(failure)},
            best_effort_draft = ${draft ?? null}, rollout_id = NULL, updated_at = ${now},
            model_json = ${fallback ? JSON.stringify(fallback) : job!.model_json},
            fallback_used = ${fallback ? 1 : job!.fallback_used}
            WHERE id = ${jobId}`
          return
        }
        const summaryId = yield* recordFailedSummary(sql, userId, job!, rolloutId, failure)
        yield* sql`UPDATE summarization_jobs SET status = 'failed', error = ${JSON.stringify(failure)},
          best_effort_draft = ${draft ?? null}, rollout_id = NULL, result_summary_id = ${summaryId}, updated_at = ${now}
          WHERE id = ${jobId}`
      }).pipe(transaction(sql, "FailSummaryAttempt")),
    RetrySummary: ({ userId, summaryId, model }) =>
      Effect.gen(function* () {
        const summary = yield* readSummary(sql, userId, summaryId)
        if (model && !(yield* ownedModel(sql, userId, model.connection, model.model)))
          return yield* new NotFound({ entity: "model", id: model.model })
        // A job already live for the range is the retry: it is brought forward, on the chosen model.
        const [live] = yield* sql<{ id: string; status: string }>`
          SELECT id, status FROM summarization_jobs WHERE chat_id = ${summary.chatId} AND level = ${summary.level}
            AND first_slot_id = ${summary.firstSlotId} AND last_slot_id = ${summary.lastSlotId} AND status IN ('pending', 'processing')`
        if (live) {
          yield* sql`UPDATE summarization_jobs SET request_class = 'interactive', updated_at = ${Date.now()},
            model_json = CASE WHEN status = 'pending' AND ${model ? 1 : 0} THEN ${JSON.stringify(model ?? null)} ELSE model_json END
            WHERE id = ${live.id}`
          return { jobId: live.id }
        }
        const chain = yield* lcmPath(sql, userId, summary.chatId, summary.lastSlotId, summary.firstSlotId)
        if (chain[0]?.id !== summary.firstSlotId || chain.some((s) => s.generating || s.merged))
          return yield* reject("RetrySummary", "The summary's range is not ready to summarize.")
        if (summary.level === 1 && chain.every((s) => s.versionId === null))
          return yield* reject("RetrySummary", "Nothing in the summary's range can be summarized now.")
        const id = uuidv7(),
          now = Date.now()
        yield* sql`INSERT INTO summarization_jobs ${sql.insert({
          id,
          chat_id: summary.chatId,
          level: summary.level,
          first_slot_id: summary.firstSlotId,
          last_slot_id: summary.lastSlotId,
          leaf_slot_id: summary.lastSlotId,
          target_token_count: yield* targetFor(sql, summary.chatId, summary.level),
          clip_tokens: 6000,
          input_child_ids: summary.level > 1 ? JSON.stringify(summary.children.map((c) => c.summaryId)) : null,
          prefix_json: yield* prefixAt(sql, summary.chatId, summary.lastSlotId),
          model_json: model ? JSON.stringify(model) : null,
          batch_id: uuidv7(),
          request_class: "interactive",
          created_at: now,
          updated_at: now
        })}`
        return { jobId: id }
      }).pipe(transaction(sql, "RetrySummary")),
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
