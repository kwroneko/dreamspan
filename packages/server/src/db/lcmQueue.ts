import { inJobFork, withdrawReruns } from "./lcmFork.ts"
import { viewAt } from "./forkState.ts"
import { onPath as slotOnPath } from "./forks.ts"
import { eventAppliesSql } from "./forkState.ts"
import { completeEmpty } from "./lcmEmpty.ts"
import { summaryIsWarm } from "./lcmWarmth.ts"
import { inFork } from "./forkState.ts"
import type { SummaryPrefix } from "../lcm/prefix.ts"
import { lineageValidator } from "./lcmLayer.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ContextSnapshot } from "../assembler/types.ts"
import { ownedModel } from "./generationSettings.ts"
import { drivenSql, enforceCaps, heldSql } from "./lcmBackfill.ts"
import { fallbackModel, type JobError, prefixAt, recordFailedSummary } from "./lcmFailures.ts"
import { readSummary } from "./lcmReads.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { jobColumns, type SummaryJob } from "./lcmJobs.ts"
import { MAX_CHUNK_SLOTS } from "./lcmLimits.ts"
import { lcmPath, slotInput } from "./lcmPath.ts"
import { pathView, placesOf, positionIn } from "./lcmDisplay.ts"
import type { PathPiece } from "./displayPath.ts"
import { NotFound, StorageError, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

/** How far above the leaf a plan's triggering reply may be; replies are the last few messages. */
const MAX_TRIGGER_DISTANCE = 5000

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
  /**
   * The live jobs of a level in fork `fork` whose display range overlaps positions `first` to
   * `last` (spec/MESSAGE-INSERT.md §3.4). A job whose ends the fork doesn't show is kept, with
   * its span, for the caller's check by slot.
   */
  const nearInDisplay = (
    chatId: string,
    fork: string | null,
    level: number,
    shown: { readonly pieces: ReadonlyArray<PathPiece> },
    first: number,
    last: number
  ) =>
    Effect.gen(function* () {
      const jobs = yield* sql<{ id: string; status: string; first_slot_id: string; last_slot_id: string }>`
        SELECT j.id,j.status,j.first_slot_id,j.last_slot_id FROM summarization_jobs j
        WHERE j.chat_id = ${chatId} AND j.fork_id IS ${fork} AND j.level = ${level} AND j.status IN ('pending', 'processing')`
      const places = yield* placesOf(
        sql,
        chatId,
        jobs.flatMap((j) => [j.first_slot_id, j.last_slot_id])
      )
      return jobs.flatMap((j) => {
        const a = positionIn(shown.pieces, places.get(j.first_slot_id)),
          b = positionIn(shown.pieces, places.get(j.last_slot_id))
        if (a === null || b === null) return [{ ...j, span: MAX_CHUNK_SLOTS }]
        return a <= last && b >= first ? [{ ...j, span: b - a + 1 }] : []
      })
    })
  return {
    SaveLcmMaintenance: ({ userId, chatId, leafSlotId, forkId, pins }) =>
      Effect.gen(function* () {
        yield* lcmPath(sql, userId, chatId, leafSlotId, leafSlotId)
        yield* sql`INSERT INTO lcm_reply_maintenance(chat_id,fork_id,leaf_slot_id,pins_json) VALUES (${chatId},${yield* viewAt(sql, chatId, leafSlotId)},${leafSlotId},${pins})
          ON CONFLICT(chat_id,fork_id,leaf_slot_id) DO UPDATE SET pins_json=excluded.pins_json`
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), transaction(sql, "SaveLcmMaintenance")),
    // Work here depends on the chunks and the jobs around them, never on the length of the chat: a
    // write holds the writer, and a long chat's first plan must not hold it for a noticeable time.
    EnqueueSummaries: ({ userId, chatId, leafSlotId, forkId, chunks, requestClass, triggerVersionId }) =>
      Effect.gen(function* () {
        yield* lcmPath(sql, userId, chatId, leafSlotId, leafSlotId)
        if (chunks.length > 8)
          return yield* reject("EnqueueSummaries", "A write accepts at most eight bounded chunks; plan again.")
        if (triggerVersionId) {
          // The reply that triggered the plan lies on the leaf's path: walk up from the leaf by the
          // difference of their depths, which is a few steps however long the chat is.
          const [near] = yield* sql<{ ok: number }>`
            WITH RECURSIVE up(id, n) AS (
              SELECT l.id, 0 FROM slots l WHERE l.id = ${leafSlotId} AND l.chat_id = ${chatId}
              UNION ALL SELECT s.parent_slot_id, u.n + 1 FROM slots s JOIN up u ON u.id = s.id
                WHERE s.parent_slot_id IS NOT NULL AND u.n < ${MAX_TRIGGER_DISTANCE}
            )
            SELECT EXISTS (SELECT 1 FROM versions v JOIN up ON up.id = v.slot_id WHERE v.id = ${triggerVersionId}) AS ok`
          if (!near?.ok) return yield* new NotFound({ entity: "summary trigger", id: triggerVersionId })
        }
        const fork = yield* viewAt(sql, chatId, leafSlotId)
        const prefix = yield* prefixAt(sql, chatId, leafSlotId, triggerVersionId)
        // A fork that shows inserted slots compares positions on its display path (spec/MESSAGE-INSERT.md §3.4).
        const shown = yield* pathView(sql, chatId, leafSlotId)
        const valid = lineageValidator(sql, userId, shown ?? undefined)
        const batchId = uuidv7(),
          now = Date.now(),
          result: SummaryJob[] = []
        const withdraw = (ids: ReadonlyArray<string> | undefined) => withdrawReruns(sql, chatId, ids)
        for (const chunk of chunks) {
          if (chunk.sourceSummaryId) {
            const source = yield* readSummary(sql, userId, chunk.sourceSummaryId)
            if (source.chatId !== chatId) return yield* new NotFound({ entity: "summary", id: source.id })
            if (source.revisionId !== chunk.sourceRevisionId) continue
          }
          const first = chunk.inputs[0]?.slotId,
            last = chunk.inputs.at(-1)?.slotId
          if (!first || !last || chunk.target <= 0 || chunk.inputs.length > MAX_CHUNK_SLOTS)
            return yield* reject("EnqueueSummaries", "The summary chain or its inputs changed; plan again.")
          const chain = yield* lcmPath(sql, userId, chatId, last, first, chunk.inputs.length)
          if (
            chain[0]?.id !== first ||
            chain.some((s) => s.generating || s.merged) ||
            JSON.stringify(chain.map(slotInput)) !== JSON.stringify(chunk.inputs)
          )
            return yield* reject("EnqueueSummaries", "The summary chain or its inputs changed; plan again.")
          // Already summarized: a fresh level-1 summary over any of these slots. A rewrite of a stale
          // summary is its own range's business, so overlapping fresh ones don't make it redundant.
          if (!chunk.refresh) {
            const owners = yield* sql<{ id: string; last_slot_id: string }>`
              SELECT DISTINCT s.id,s.last_slot_id FROM summary_inputs i JOIN summaries s ON s.id = i.summary_id
              WHERE i.slot_id IN ${
                shown
                  ? sql.in(chain.map((c) => c.id))
                  : sql`(WITH RECURSIVE chain(id,n) AS (
                SELECT ${last},1 UNION ALL SELECT s.parent_slot_id,c.n+1 FROM slots s JOIN chain c ON c.id=s.id
                  WHERE c.n < ${chunk.inputs.length}
              ) SELECT id FROM chain)`
              } AND s.chat_id = ${chatId} AND s.level = 1
                AND s.sealed = 1 AND s.status IN ('complete', 'truncated')`
            const ownerPlaces = shown
              ? yield* placesOf(
                  sql,
                  chatId,
                  owners.map((o) => o.last_slot_id)
                )
              : null
            const ownerShown = (slot: string) =>
              shown && ownerPlaces
                ? Effect.succeed((positionIn(shown.pieces, ownerPlaces.get(slot)) ?? Infinity) <= shown.end)
                : slotOnPath(sql, chatId, leafSlotId, slot)
            let covered = false
            for (const owner of owners)
              if (
                (yield* ownerShown(owner.last_slot_id)) &&
                (yield* valid(owner.id)) &&
                (yield* readSummary(sql, userId, owner.id, undefined, undefined, shown ?? undefined)).fresh
              )
                covered = true
            if (covered) {
              yield* withdraw(chunk.rerunIds)
              continue
            }
          }
          const ids = new Set(chain.map((s) => s.id))
          const near = shown
            ? yield* nearInDisplay(chatId, fork, 1, shown, chain[0]!.position, chain.at(-1)!.position)
            : yield* sql<{
                id: string
                status: string
                first_slot_id: string
                last_slot_id: string
                span: number
              }>`SELECT j.id,j.status,j.first_slot_id, j.last_slot_id, b.depth - a.depth + 1 AS span FROM summarization_jobs j
              JOIN slots a ON a.id = j.first_slot_id JOIN slots b ON b.id = j.last_slot_id
            WHERE j.chat_id = ${chatId} AND j.fork_id IS ${fork} AND j.level = 1 AND j.status IN ('pending', 'processing')
              AND a.depth <= ${chain.at(-1)!.depth} AND b.depth >= ${chain[0]!.depth}`
          const answering = chunk.rerunIds?.length
            ? near.find((j) => j.status === "pending" && j.first_slot_id === first && j.last_slot_id === last)
            : undefined
          if (answering) {
            yield* sql`UPDATE summarization_jobs SET explicit_requested=1,request_class=${requestClass},
              model_json=${chunk.model ? JSON.stringify(chunk.model) : null},prefix_json=${prefix},
              source_summary_id=${chunk.sourceSummaryId ?? null},source_revision_id=${chunk.sourceRevisionId ?? null},
              rerun_ids_json=${JSON.stringify(chunk.rerunIds)},target_token_count=${chunk.target},clip_tokens=${chunk.clipTokens ?? 6000},updated_at=${now}
              WHERE id=${answering.id} AND status='pending'`
            yield* withdraw(chunk.rerunIds)
            result.push(yield* get(userId, answering.id))
            continue
          }
          let overlap = false
          for (const p of near) {
            const other = yield* lcmPath(sql, userId, chatId, p.last_slot_id, p.first_slot_id, p.span)
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
            fork_id: fork,
            level: 1,
            first_slot_id: chain[0]!.id,
            last_slot_id: chain.at(-1)!.id,
            leaf_slot_id: leafSlotId,
            target_token_count: chunk.target,
            clip_tokens: chunk.clipTokens ?? 6000,
            prefix_json: prefix,
            batch_id: batchId,
            model_json: chunk.model ? JSON.stringify(chunk.model) : null,
            source_summary_id: chunk.sourceSummaryId ?? null,
            source_revision_id: chunk.sourceRevisionId ?? null,
            rerun_ids_json: chunk.rerunIds ? JSON.stringify(chunk.rerunIds) : null,
            explicit_requested: chunk.explicitRequested || chunk.rerunIds?.length ? 1 : 0,
            request_class: requestClass,
            created_at: now,
            updated_at: now
          })}`
          if (chunk.inputs.every((i) => i.versionId === null))
            yield* completeEmpty(sql, id, chatId, batchId, chunk.inputs)
          yield* withdraw(chunk.rerunIds)
          result.push(yield* get(userId, id))
        }
        return result
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), transaction(sql, "EnqueueSummaries")),
    EnqueueCondensations: ({ userId, chatId, leafSlotId, forkId, triggerVersionId, jobs: planned, requestClass }) =>
      Effect.gen(function* () {
        yield* lcmPath(sql, userId, chatId, leafSlotId, leafSlotId)
        const onPath = (slotId: string) =>
          sql<{ n: number }>`WITH RECURSIVE path(id) AS (
            SELECT ${leafSlotId} UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
          ) SELECT count(*) AS n FROM path WHERE id = ${slotId}`.pipe(Effect.map(([row]) => row!.n === 1))
        const fork = yield* viewAt(sql, chatId, leafSlotId)
        const prefix = yield* prefixAt(sql, chatId, leafSlotId, triggerVersionId)
        // In a fork that shows inserted slots, parts follow one another on its display path.
        const shown = yield* pathView(sql, chatId, leafSlotId)
        const shownAt = (slots: ReadonlyArray<string>) =>
          shown
            ? Effect.map(
                placesOf(sql, chatId, slots),
                (places) => (slot: string) => positionIn(shown.pieces, places.get(slot))
              )
            : Effect.succeed((_slot: string): number | null => null)
        const now = Date.now(),
          result: SummaryJob[] = []
        const withdraw = (ids: ReadonlyArray<string> | undefined) => withdrawReruns(sql, chatId, ids)
        for (const job of planned) {
          if (job.sourceSummaryId) {
            const source = yield* readSummary(sql, userId, job.sourceSummaryId)
            if (source.chatId !== chatId) return yield* new NotFound({ entity: "summary", id: source.id })
            if (source.revisionId !== job.sourceRevisionId) continue
          }
          const children: Array<Summary> = []
          for (const id of job.children) children.push(yield* readSummary(sql, userId, id))
          const first = children[0],
            last = children.at(-1)
          if (!first || !last || children.length < 2)
            return yield* reject("EnqueueCondensations", "A condensation needs at least two parts.")
          const at = yield* shownAt(children.flatMap((c) => [c.firstSlotId, c.lastSlotId]))
          for (const [n, child] of children.entries()) {
            if (child.chatId !== chatId || child.status === "failed" || child.level >= job.level)
              return yield* reject("EnqueueCondensations", "Parts must be this chat's summaries below the new level.")
            if (n > 0 && shown) {
              const previous = at(children[n - 1]!.lastSlotId)
              if (previous === null || at(child.firstSlotId) !== previous + 1)
                return yield* reject("EnqueueCondensations", "Parts must follow one another along one chain.")
            } else if (n > 0) {
              const [link] = yield* sql<{
                ok: number
              }>`SELECT parent_slot_id = ${children[n - 1]!.lastSlotId} AS ok FROM slots WHERE id = ${child.firstSlotId}`
              if (!link?.ok)
                return yield* reject("EnqueueCondensations", "Parts must follow one another along one chain.")
            }
          }
          if (
            shown
              ? at(first.firstSlotId) === null || (at(last.lastSlotId) ?? Infinity) > shown.end
              : !(yield* onPath(last.lastSlotId))
          )
            return yield* reject("EnqueueCondensations", "The parts are not on the path being planned.")
          if (job.absorbedParentId) {
            const parent = yield* readSummary(sql, userId, job.absorbedParentId)
            const own = new Set(job.children as ReadonlyArray<string>)
            if (
              parent.chatId !== chatId ||
              parent.level !== job.level ||
              parent.children.some((c) => !own.has(c.summaryId))
            )
              return yield* reject("EnqueueCondensations", "Absorption must reduce the parent's own parts again.")
          }
          // A live job of this level that starts on this chain at or before the last part and ends at or after the first.
          const [clash] = shown
            ? yield* nearInDisplay(chatId, fork, job.level, shown, at(first.firstSlotId)!, at(last.lastSlotId)!)
            : yield* sql<{ id: string; status: string; first_slot_id: string; last_slot_id: string }>`
            SELECT j.id,j.status,j.first_slot_id,j.last_slot_id FROM summarization_jobs j JOIN slots b ON b.id = j.last_slot_id
            WHERE j.chat_id = ${chatId} AND j.fork_id IS ${fork} AND j.level = ${job.level} AND j.status IN ('pending', 'processing')
              AND b.depth >= (SELECT depth FROM slots WHERE id = ${first.firstSlotId})
              AND j.first_slot_id IN (WITH RECURSIVE up(id) AS (
                SELECT ${last.lastSlotId} UNION ALL SELECT s.parent_slot_id FROM slots s JOIN up u ON u.id = s.id WHERE s.parent_slot_id IS NOT NULL
              ) SELECT id FROM up)
            LIMIT 1`
          if (clash) {
            if (
              job.rerunIds?.length &&
              clash.status === "pending" &&
              clash.first_slot_id === first.firstSlotId &&
              clash.last_slot_id === last.lastSlotId
            ) {
              yield* sql`UPDATE summarization_jobs SET explicit_requested=1,request_class=${requestClass},
                model_json=${job.model ? JSON.stringify(job.model) : null},prefix_json=${prefix},input_child_ids=${JSON.stringify(job.children)},
                source_summary_id=${job.sourceSummaryId ?? null},source_revision_id=${job.sourceRevisionId ?? null},
                rerun_ids_json=${JSON.stringify(job.rerunIds)},target_token_count=${job.target},updated_at=${now}
                WHERE id=${clash.id} AND status='pending'`
              yield* withdraw(job.rerunIds)
              result.push(yield* get(userId, clash.id))
            }
            continue
          }
          const id = uuidv7()
          yield* sql`INSERT INTO summarization_jobs ${sql.insert({
            id,
            chat_id: chatId,
            fork_id: fork,
            level: job.level,
            first_slot_id: first.firstSlotId,
            last_slot_id: last.lastSlotId,
            leaf_slot_id: leafSlotId,
            target_token_count: job.target,
            clip_tokens: 6000,
            input_child_ids: JSON.stringify(job.children),
            absorbed_parent_id: job.absorbedParentId ?? null,
            eager: job.eager ? 1 : 0,
            model_json: job.model ? JSON.stringify(job.model) : null,
            prefix_json: prefix,
            source_summary_id: job.sourceSummaryId ?? null,
            source_revision_id: job.sourceRevisionId ?? null,
            rerun_ids_json: job.rerunIds ? JSON.stringify(job.rerunIds) : null,
            explicit_requested: job.explicitRequested || job.rerunIds?.length ? 1 : 0,
            request_class: requestClass,
            created_at: now,
            updated_at: now
          })}`
          if (children.every((c) => c.content === "" && c.fresh))
            yield* completeEmpty(sql, id, chatId, null, [], children, job.level)
          yield* withdraw(job.rerunIds)
          result.push(yield* get(userId, id))
        }
        return result
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), transaction(sql, "EnqueueCondensations")),
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
        // A chat whose backfill is paused or has reached its cap (spec/LCM.md §2.11) starts nothing.
        yield* enforceCaps(sql, userId)
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
        // "When it runs" (DESIGN §8): the chat's setting, else the account default's (`spendAhead`
        // is its old name). With the next reply, nothing runs ahead but a driven backfill's work.
        const spends = (job: string) =>
          `(coalesce((SELECT json_extract(e.value_json,'$.when') FROM state_events e
              WHERE e.chat_id = ${job}.chat_id AND e.slot_id IS NULL AND e.scope IS NULL AND e.key = 'lcm.settings' AND ${eventAppliesSql(`${job}.fork_id`, "e")}
              ORDER BY e.seq DESC LIMIT 1),
            (SELECT coalesce(json_extract(value_json,'$.when'),
                CASE json_extract(value_json,'$.spendAhead') WHEN 0 THEN 'next-reply' END)
              FROM user_settings WHERE user_id = ? AND key = 'generation.lcm'),
            'after-reply') <> 'next-reply' OR ${drivenSql(`${job}.chat_id`, `${job}.fork_id`)})`
        const [next] = yield* sql.unsafe<{ id: string }>(
          `SELECT j.id FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id
        JOIN slots start ON start.id = j.first_slot_id
        WHERE c.owner_user_id = ? AND c.deleted_at IS NULL AND j.status = 'pending'
        AND (j.fork_id IS NULL OR EXISTS(SELECT 1 FROM forks jf WHERE jf.id=j.fork_id AND jf.deleted_at IS NULL))
        AND NOT ${heldSql("j.chat_id", "j.fork_id")}
        AND (j.request_class = 'interactive' OR j.explicit_requested = 1 OR ${spends("j")})
        AND (SELECT count(*) FROM summarization_jobs busy JOIN chats bc ON bc.id = busy.chat_id
          WHERE bc.owner_user_id = ? AND busy.status = 'processing') < 2
        AND (j.level > 1 OR NOT EXISTS (SELECT 1 FROM summarization_jobs busy JOIN slots bs ON bs.id = busy.first_slot_id
          WHERE busy.chat_id = j.chat_id AND busy.fork_id IS j.fork_id AND busy.level = 1 AND
            (busy.status = 'processing' OR (busy.status = 'pending'
             AND (busy.request_class = 'interactive' OR busy.explicit_requested = 1 OR ${spends("busy")}
               OR busy.last_slot_id IN (WITH RECURSIVE ancestors(id) AS (SELECT j.last_slot_id UNION ALL SELECT s.parent_slot_id FROM slots s JOIN ancestors a ON a.id=s.id WHERE s.parent_slot_id IS NOT NULL) SELECT id FROM ancestors))
             AND (bs.depth < start.depth OR (bs.depth = start.depth AND busy.id < j.id))))))
        ORDER BY CASE j.request_class WHEN 'interactive' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END, j.created_at, j.id LIMIT 1`,
          [userId, userId, userId, userId]
        )
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
          fork_id: j.forkId,
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
      }).pipe(inJobFork(sql, jobId), transaction(sql, "FailSummaryAttempt")),
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
        return yield* sql<{
          userId: UserId
          chatId: SummaryJob["chatId"]
          forkId: SummaryJob["forkId"]
          leafSlotId: SummaryJob["leafSlotId"]
        }>`
          SELECT c.owner_user_id AS userId,c.id AS chatId,f.id AS forkId,f.tip_slot_id AS leafSlotId
          FROM chats c JOIN forks f ON f.chat_id=c.id WHERE c.deleted_at IS NULL AND f.deleted_at IS NULL
          AND f.tip_slot_id IS NOT NULL AND (EXISTS(SELECT 1 FROM summarization_jobs j
            WHERE j.chat_id=c.id AND j.fork_id=f.id AND j.status='pending') OR
            json_extract((SELECT value_json FROM state_events e WHERE e.chat_id=c.id AND e.key='lcm.settings'
              AND ${sql.literal(eventAppliesSql("f.id", "e"))} AND e.slot_id IS NULL ORDER BY e.seq DESC LIMIT 1),'$.enabled')=1)`
      }).pipe(transaction(sql, "ResetSummaryJobs")),
    EscalateSummaryJob: ({ userId, jobId }) =>
      Effect.gen(function* () {
        yield* get(userId, jobId)
        yield* sql`UPDATE summarization_jobs SET request_class = 'interactive', updated_at = ${Date.now()}
        WHERE id = ${jobId} AND status IN ('pending','processing')`
      }).pipe(transaction(sql, "EscalateSummaryJob"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
