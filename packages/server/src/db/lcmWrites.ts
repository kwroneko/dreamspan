import type { ContextSnapshot } from "../assembler/types.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { tokensOf } from "../assembler/st.ts"
import type { Bin } from "./bin.ts"
import { readSummary } from "./lcmReads.ts"
import { NotFound, StaleWrite, StorageError, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeLcmWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const refused = (reason: string) =>
      new StorageError({ operation: "CompleteSummary", reason: "constraint", message: reason })
    const current = (userId: UserId, id: string, expected: number) =>
      Effect.gen(function* () {
        const summary = yield* readSummary(sql, userId, id)
        if (summary.rowVersion !== expected)
          return yield* new StaleWrite({ entity: "summary", id, expected, actual: summary.rowVersion })
        return summary
      })
    return {
      CompleteSummary: ({ userId, jobId, rolloutId, content, status, inputs, children }) =>
        Effect.gen(function* () {
          const [job] = yield* sql<{
            rollout_id: string | null
            chat_id: string
            level: number
            first_slot_id: string
            last_slot_id: string
            batch_id: string | null
            input_child_ids: string | null
            absorbed_parent_id: string | null
            source_summary_id: string | null
            source_revision_id: string | null
          }>`
        SELECT j.* FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id
        WHERE j.id = ${jobId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND j.status = 'processing'`
          if (!job) return yield* new NotFound({ entity: "summary job", id: jobId })
          const [rollout] = yield* sql`SELECT id FROM rollouts WHERE id = ${rolloutId} AND chat_id = ${job.chat_id}
        AND status = 'running' AND kind = ${job.level === 1 ? "summarize" : "condense"}`
          if (!rollout) return yield* new NotFound({ entity: "summary rollout", id: rolloutId })
          if (job.rollout_id !== null) {
            const [payload] = yield* sql<{
              context_snapshot_json: string
            }>`SELECT context_snapshot_json FROM rollout_payloads WHERE rollout_id = ${rolloutId}`
            const frozen = payload
              ? (JSON.parse(payload.context_snapshot_json) as ContextSnapshot).summaryJob
              : undefined
            if (
              job.rollout_id !== rolloutId ||
              frozen?.id !== jobId ||
              JSON.stringify(frozen.inputs) !== JSON.stringify(inputs) ||
              JSON.stringify(frozen.children ?? []) !== JSON.stringify(children)
            )
              return yield* refused("Completion must use the inputs frozen for this job's active request")
          }
          const chain = yield* sql<{
            id: string
            parent_slot_id: string | null
            merged: number
          }>`WITH RECURSIVE chain AS (
        SELECT id, parent_slot_id, depth FROM slots WHERE id = ${job.last_slot_id} AND chat_id = ${job.chat_id}
        UNION ALL SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN chain p ON p.parent_slot_id = s.id WHERE p.id <> ${job.first_slot_id} AND s.depth >= (SELECT depth FROM slots WHERE id = ${job.first_slot_id})
      ) SELECT id, parent_slot_id, EXISTS(SELECT 1 FROM slot_parents p WHERE p.slot_id = chain.id) AS merged FROM chain ORDER BY depth`
          if (chain[0]?.id !== job.first_slot_id || chain.some((s) => s.merged))
            return yield* refused("summary must cover a primary-parent chain without merges")
          if (!content.trim()) return yield* refused("a completed summary cannot be empty")
          if (job.level === 1) {
            if (children.length || inputs.length !== chain.length || inputs.some((i, n) => i.slotId !== chain[n]!.id))
              return yield* refused("L1 inputs must be exactly the job's chain, in order")
            for (const input of inputs) {
              if (input.versionId !== null) {
                const [version] =
                  yield* sql`SELECT id FROM versions WHERE id = ${input.versionId} AND slot_id = ${input.slotId}
              AND ${input.amendCount} >= 0 AND (SELECT count(*) FROM version_history h WHERE h.version_id = versions.id) >= ${input.amendCount}`
                if (!version) return yield* new NotFound({ entity: "summary input", id: input.versionId })
              } else if (input.amendCount !== 0) return yield* refused("absent inputs have no amendments")
            }
          } else {
            if (
              inputs.length ||
              !children.length ||
              JSON.stringify(children.map((c) => c.summaryId)) !== job.input_child_ids
            )
              return yield* refused("condensation must use the job's exact ordered children")
            let at = 0
            for (const child of children) {
              const summary = yield* readSummary(sql, userId, child.summaryId, child.revisionId)
              if (
                summary.chatId !== job.chat_id ||
                summary.level >= job.level ||
                summary.status === "failed" ||
                summary.firstSlotId !== chain[at]?.id ||
                summary.lastSlotId !== chain[at + summary.slotCount - 1]?.id
              )
                return yield* refused("children must partition the chain at lower levels")
              at += summary.slotCount
            }
            if (at !== chain.length) return yield* refused("children must cover the entire chain")
          }
          const supersede: Array<string> = []
          if (job.absorbed_parent_id !== null) {
            const absorbed = yield* readSummary(sql, userId, job.absorbed_parent_id)
            if (absorbed.chatId !== job.chat_id || absorbed.level !== job.level)
              return yield* refused("absorption must replace a same-level parent")
            const originals = new Set(absorbed.children.map((child) => child.summaryId))
            if (!originals.size || [...originals].some((id) => !children.some((child) => child.summaryId === id)))
              return yield* refused("absorption must reduce the original children again")
            supersede.push(
              absorbed.id,
              ...children.filter((child) => !originals.has(child.summaryId)).map((child) => child.summaryId)
            )
          }
          const id = uuidv7(),
            revisionId = uuidv7(),
            now = Date.now()
          yield* sql`INSERT INTO summary_revisions ${sql.insert({ id: revisionId, summary_id: id, content, token_count: tokensOf({ content }), origin: "generated", created_at: now })}`
          yield* sql`INSERT INTO summaries ${sql.insert({
            id,
            chat_id: job.chat_id,
            level: job.level,
            selected_revision_id: revisionId,
            first_slot_id: job.first_slot_id,
            last_slot_id: job.last_slot_id,
            slot_count: chain.length,
            status,
            rollout_id: rolloutId,
            batch_id: job.batch_id,
            created_at: now
          })}`
          for (const [ordinal, input] of inputs.entries())
            yield* sql`INSERT INTO summary_inputs ${sql.insert({ summary_id: id, ordinal, slot_id: input.slotId, version_id: input.versionId, amend_count: input.amendCount })}`
          for (const [ordinal, child] of children.entries())
            yield* sql`INSERT INTO summary_parents ${sql.insert({ summary_id: id, ordinal, parent_id: child.summaryId, parent_revision_id: child.revisionId })}`
          yield* sql`UPDATE summaries SET sealed = 1 WHERE id = ${id}`
          for (const summaryId of supersede) {
            const protectedSummary = yield* readSummary(sql, userId, summaryId)
            if (protectedSummary.origin === "user" || protectedSummary.origin === "imported") continue
            yield* sql`UPDATE summaries SET status = 'superseded', row_version = row_version + 1 WHERE id = ${summaryId}`
          }
          if (job.source_summary_id !== null) {
            const source = yield* readSummary(sql, userId, job.source_summary_id)
            if (source.origin === "generated" && source.revisionId === job.source_revision_id)
              yield* sql`UPDATE lcm_summary_choices SET chosen_id=${id} WHERE chosen_id=${source.id}`
          }
          const updated =
            yield* sql`UPDATE summarization_jobs SET status = 'complete', result_summary_id = ${id}, updated_at = ${now}
        WHERE id = ${jobId} AND status = 'processing' RETURNING id`
          if (updated.length !== 1) return yield* refused("summary completion lost its job")
          yield* sql`UPDATE rollouts SET status = 'completed', updated_at = ${now}, completed_at = ${now},
        llm_requests = (SELECT count(*) FROM llm_requests WHERE rollout_id = ${rolloutId}),
        usage_input_tokens = (SELECT sum(input_uncached) FROM llm_requests WHERE rollout_id = ${rolloutId}),
        usage_output_tokens = (SELECT sum(output) FROM llm_requests WHERE rollout_id = ${rolloutId}),
        usage_cache_read_tokens = (SELECT sum(cache_read) FROM llm_requests WHERE rollout_id = ${rolloutId}),
        usage_cost = (SELECT sum(cost) FROM llm_requests WHERE rollout_id = ${rolloutId}),
        usage_cache_write_tokens = (SELECT sum(cache_write) FROM llm_requests WHERE rollout_id = ${rolloutId})
        WHERE id = ${rolloutId}`
          return yield* readSummary(sql, userId, id)
        }).pipe(transaction(sql, "CompleteSummary")),
      EditSummary: ({ userId, summaryId, content, expectedRowVersion, commitDraft }) =>
        Effect.gen(function* () {
          yield* current(userId, summaryId, expectedRowVersion)
          const revisionId = uuidv7()
          yield* sql`INSERT INTO summary_revisions ${sql.insert({ id: revisionId, summary_id: summaryId, content, token_count: tokensOf({ content }), origin: "user", created_at: Date.now() })}`
          yield* sql`UPDATE summaries SET selected_revision_id = ${revisionId}, row_version = row_version + 1 WHERE id = ${summaryId}`
          yield* sql`DELETE FROM lcm_summary_choices WHERE summary_id=${summaryId}`
          const { recovered } = yield* bin.drafts.commit(userId, commitDraft, {
            targetKind: "summary_edit",
            targetId: summaryId,
            content
          })
          return { summary: yield* readSummary(sql, userId, summaryId), recovered }
        }).pipe(transaction(sql, "EditSummary")),
      SelectSummaryRevision: ({ userId, summaryId, revisionId, expectedRowVersion }) =>
        Effect.gen(function* () {
          yield* current(userId, summaryId, expectedRowVersion)
          const [revision] = yield* sql<{
            summary_id: string
          }>`SELECT summary_id FROM summary_revisions WHERE id=${revisionId}`
          const target = revision?.summary_id
          if (!target) return yield* new NotFound({ entity: "summary revision", id: revisionId })
          if (target !== summaryId) {
            const [replacement] = yield* sql`SELECT 1 FROM summarization_jobs
              WHERE source_summary_id=${summaryId} AND result_summary_id=${target} AND status='complete'`
            if (!replacement) return yield* new NotFound({ entity: "summary revision", id: revisionId })
            yield* readSummary(sql, userId, target, revisionId)
            yield* sql`INSERT INTO lcm_summary_choices(summary_id,chosen_id) VALUES (${summaryId},${target})
              ON CONFLICT(summary_id) DO UPDATE SET chosen_id=excluded.chosen_id`
            yield* sql`UPDATE summaries SET row_version=row_version+1 WHERE id=${summaryId}`
          } else {
            yield* readSummary(sql, userId, summaryId, revisionId)
            yield* sql`DELETE FROM lcm_summary_choices WHERE summary_id=${summaryId}`
          }
          yield* sql`UPDATE summaries SET selected_revision_id = ${revisionId}, row_version = row_version + 1 WHERE id = ${target}`
          return yield* readSummary(sql, userId, target)
        }).pipe(transaction(sql, "SelectSummaryRevision"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  })
