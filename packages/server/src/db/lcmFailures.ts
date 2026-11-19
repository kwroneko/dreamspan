import type { ContextSnapshot } from "../assembler/types.ts"
import { takeSummaryPrefix } from "../lcm/prefix.ts"
import { shownIn, viewAt } from "./forkState.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { ownedModel } from "./generationSettings.ts"
import { readSummary } from "./lcmReads.ts"
import { shownImages } from "./lcmImages.ts"
import { audienceIds } from "./lcmAudience.ts"
import { lcmPath, slotInput } from "./lcmPath.ts"

/** How a job failed, as its error and its failed summary record it (the class and reason of a failed version). */
export interface JobError {
  readonly class: string
  readonly message: string
  readonly kind?: "hard" | "soft"
  readonly category?: string | null
}

/**
 * The reply prefix to pin for a job: the reply that triggered it, else the closest selected reply
 * above `leafSlotId`. The search is bounded, so it costs the same in a chat of any length; a job
 * without a pinned prefix is assembled from scratch.
 */
export const prefixAt = (sql: SqlClient.SqlClient, chatId: string, leafSlotId: string, triggerVersionId?: string) =>
  Effect.gen(function* () {
    const fork = yield* viewAt(sql, chatId, leafSlotId)
    const [origin] = triggerVersionId
      ? yield* sql<{ snapshot: string }>`
          SELECT p.context_snapshot_json AS snapshot FROM versions v JOIN slots s ON s.id = v.slot_id
            JOIN rollouts r ON r.id = v.rollout_id JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE v.id = ${triggerVersionId} AND s.chat_id = ${chatId} AND r.kind = 'generation'
            AND p.context_snapshot_json IS NOT NULL`
      : yield* sql<{ snapshot: string }>`WITH RECURSIVE path(id, n) AS (
          SELECT ${leafSlotId}, 1 UNION ALL SELECT s.parent_slot_id, p.n + 1 FROM slots s JOIN path p ON p.id = s.id
            WHERE s.parent_slot_id IS NOT NULL AND p.n < 400
        ) SELECT p.context_snapshot_json AS snapshot FROM path a JOIN slots s ON s.id = a.id
          JOIN versions v ON v.id = ${shownIn(sql, fork, "s")} JOIN rollouts r ON r.id = v.rollout_id
          JOIN rollout_payloads p ON p.rollout_id = r.id WHERE r.chat_id = ${chatId} AND r.kind = 'generation'
          AND p.context_snapshot_json IS NOT NULL ORDER BY s.depth DESC LIMIT 1`
    return origin ? JSON.stringify(takeSummaryPrefix(JSON.parse(origin.snapshot) as ContextSnapshot)) : null
  })

/**
 * The end of a job's retries: a summary row with status `failed`, its inputs (or children) and its
 * error, and an empty revision (spec/LCM.md §2.8). It never replaces the original messages in a
 * context; the planner leaves its range alone while its inputs are unchanged. Nothing is written if
 * the job's range is no longer a clean primary-parent chain or its chat is gone.
 */
export const recordFailedSummary = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  job: {
    readonly id: string
    readonly chat_id: string
    readonly level: number
    readonly first_slot_id: string
    readonly last_slot_id: string
    readonly batch_id: string | null
    readonly input_child_ids: string | null
    /** A view's job (db/lcmAudience.ts): its failure is that view's. */
    readonly audience_json?: string | null
  },
  rolloutId: string | null,
  error: JobError
) =>
  Effect.gen(function* () {
    const audience = job.audience_json ?? null
    const chain = yield* lcmPath(
      sql,
      userId,
      job.chat_id,
      job.last_slot_id,
      job.first_slot_id,
      Number.MAX_SAFE_INTEGER,
      audience === null ? undefined : audienceIds(audience)
    ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([])))
    if (!chain.length || chain[0]!.id !== job.first_slot_id) return null
    const children: Array<{ summaryId: string; revisionId: string }> = []
    if (job.level > 1) {
      const ids = JSON.parse(job.input_child_ids ?? "[]") as string[]
      let at = 0
      for (const id of ids) {
        const child = yield* readSummary(sql, userId, id).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
        if (
          !child ||
          child.status === "failed" ||
          child.firstSlotId !== chain[at]?.id ||
          child.lastSlotId !== chain[at + child.slotCount - 1]?.id
        )
          return null
        children.push({ summaryId: child.id, revisionId: child.revisionId })
        at += child.slotCount
      }
      if (!children.length || at !== chain.length) return null
    }
    const id = uuidv7(),
      revisionId = uuidv7(),
      now = Date.now()
    yield* sql`INSERT INTO summary_revisions ${sql.insert({ id: revisionId, summary_id: id, rollout_id: rolloutId, content: "", token_count: 0, origin: "generated", created_at: now })}`
    yield* sql`INSERT INTO summaries ${sql.insert({
      id,
      chat_id: job.chat_id,
      level: job.level,
      selected_revision_id: revisionId,
      first_slot_id: job.first_slot_id,
      last_slot_id: job.last_slot_id,
      slot_count: chain.length,
      status: "failed",
      error_json: JSON.stringify(error),
      rollout_id: rolloutId,
      batch_id: job.batch_id,
      created_at: now,
      audience_json: audience,
      // A failed range holds while the fork shows what it failed over, images included.
      images_json:
        job.level === 1
          ? yield* shownImages(
              sql,
              chain.map((s) => s.versionId),
              Effect.succeed(chain.flatMap((s) => s.images.map((image) => image.mediaId)))
            )
          : null
    })}`
    if (job.level === 1)
      for (const [ordinal, s] of chain.entries()) {
        const input = slotInput(s)
        yield* sql`INSERT INTO summary_inputs ${sql.insert({ summary_id: id, ordinal, slot_id: input.slotId, version_id: input.versionId, amend_count: input.amendCount })}`
      }
    for (const [ordinal, child] of children.entries())
      yield* sql`INSERT INTO summary_parents ${sql.insert({ summary_id: id, ordinal, parent_id: child.summaryId, parent_revision_id: child.revisionId })}`
    yield* sql`UPDATE summaries SET sealed = 1 WHERE id = ${id}`
    return id
  })

/** The user's fallback summarizer model, when it is still theirs. */
export const fallbackModel = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{
      connection: string | null
      model: string | null
    }>`SELECT json_extract(value_json, '$.fallback.connection') AS connection, json_extract(value_json, '$.fallback.model') AS model
      FROM settings WHERE scope = 'user' AND scope_id = ${userId} AND key = 'generation.lcm'`
    return row?.connection && row.model && (yield* ownedModel(sql, userId, row.connection, row.model))
      ? { connection: row.connection, model: row.model }
      : null
  })
