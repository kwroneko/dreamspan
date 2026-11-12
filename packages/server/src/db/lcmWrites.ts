import { inJobFork, inSummaryFork, summaryChoices } from "./lcmFork.ts"
import { viewAt, writeOverride } from "./forkState.ts"
import type { ContextSnapshot } from "../assembler/types.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { tokensOf } from "../assembler/st.ts"
import type { Bin } from "./bin.ts"
import { readSummary } from "./lcmReads.ts"
import { requestImages, shownImages } from "./lcmImages.ts"
import { audienceIds } from "./lcmAudience.ts"
import { lcmPath } from "./lcmPath.ts"
import { followsInDisplay, lcmView, placesOf, positionIn } from "./lcmDisplay.ts"
import type { Summary } from "@rp/shared/lcm.ts"
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
    const choose = (
      chatId: string,
      id: string,
      kind: "summary_revision" | "summary_choice" | "summary_superseded",
      valueId: string
    ) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ first_slot_id: string }>`SELECT first_slot_id FROM summaries WHERE id=${id}`
        return yield* writeOverride(
          sql,
          { id: (yield* viewAt(sql, chatId, null))!, chatId },
          {
            kind,
            targetId: id,
            slotId: row!.first_slot_id,
            valueId,
            flag: null
          }
        )
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
            audience_json: string | null
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
          let request: ContextSnapshot | undefined
          if (job.rollout_id !== null) {
            const [payload] = yield* sql<{
              context_snapshot_json: string
            }>`SELECT context_snapshot_json FROM rollout_payloads WHERE rollout_id = ${rolloutId}`
            request = payload ? (JSON.parse(payload.context_snapshot_json) as ContextSnapshot) : undefined
            const frozen = request?.summaryJob
            if (
              job.rollout_id !== rolloutId ||
              frozen?.id !== jobId ||
              JSON.stringify(frozen.inputs) !== JSON.stringify(inputs) ||
              JSON.stringify(frozen.children ?? []) !== JSON.stringify(children)
            )
              return yield* refused("Completion must use the inputs frozen for this job's active request")
          }
          // In a job's fork that shows inserted slots, its range is a stretch of the display path
          // (spec/MESSAGE-INSERT.md §3.4): inputs, or parts, follow one another there with only
          // inserted slots between them. A job claimed before an insertion inside its range
          // completes with its inputs, and its summary is stale there at once.
          const view = yield* lcmView(sql, job.chat_id, yield* viewAt(sql, job.chat_id, job.last_slot_id))
          const ends = view.pieces ? yield* placesOf(sql, job.chat_id, [job.first_slot_id, job.last_slot_id]) : null
          const shown = view.pieces && ends ? positionIn(view.pieces, ends.get(job.last_slot_id)) : null
          let count: number
          if (view.pieces && ends && shown !== null) {
            const pieces = view.pieces
            const start = positionIn(pieces, ends.get(job.first_slot_id))
            if (!content.trim()) return yield* refused("a completed summary cannot be empty")
            if (job.level === 1) {
              const places = yield* placesOf(
                sql,
                job.chat_id,
                inputs.map((i) => i.slotId)
              )
              const at = (slot: string) => positionIn(pieces, places.get(slot))
              if (
                children.length ||
                inputs[0]?.slotId !== job.first_slot_id ||
                inputs.at(-1)?.slotId !== job.last_slot_id ||
                !followsInDisplay(
                  pieces,
                  inputs.map((i) => [at(i.slotId), at(i.slotId)] as const),
                  start,
                  shown
                )
              )
                return yield* refused("L1 inputs must be exactly the job's chain, in order")
              for (const input of inputs) {
                if (input.versionId !== null) {
                  const [version] =
                    yield* sql`SELECT id FROM versions WHERE id = ${input.versionId} AND slot_id = ${input.slotId}
              AND ${input.amendCount} >= 0 AND (SELECT count(*) FROM version_history h WHERE h.version_id = versions.id) >= ${input.amendCount}`
                  if (!version) return yield* new NotFound({ entity: "summary input", id: input.versionId })
                } else if (input.amendCount !== 0) return yield* refused("absent inputs have no amendments")
              }
              count = inputs.length
            } else {
              if (
                inputs.length ||
                !children.length ||
                JSON.stringify(children.map((c) => c.summaryId)) !== job.input_child_ids
              )
                return yield* refused("condensation must use the job's exact ordered children")
              const parts: Array<Summary> = []
              for (const child of children)
                parts.push(yield* readSummary(sql, userId, child.summaryId, child.revisionId))
              const places = yield* placesOf(
                sql,
                job.chat_id,
                parts.flatMap((part) => [part.firstSlotId, part.lastSlotId])
              )
              const at = (slot: string) => positionIn(pieces, places.get(slot))
              if (
                parts.some(
                  (part) => part.chatId !== job.chat_id || part.level >= job.level || part.status === "failed"
                ) ||
                !followsInDisplay(
                  pieces,
                  parts.map((part) => [at(part.firstSlotId), at(part.lastSlotId)] as const),
                  start,
                  shown
                )
              )
                return yield* refused("children must partition the chain at lower levels")
              count = parts.reduce((n, part) => n + part.slotCount, 0)
            }
          } else {
            const chain = yield* sql<{
              id: string
              parent_slot_id: string | null
            }>`WITH RECURSIVE chain AS (
          SELECT id, parent_slot_id, depth FROM slots WHERE id = ${job.last_slot_id} AND chat_id = ${job.chat_id}
          UNION ALL SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN chain p ON p.parent_slot_id = s.id WHERE p.id <> ${job.first_slot_id} AND s.depth >= (SELECT depth FROM slots WHERE id = ${job.first_slot_id})
        ) SELECT id, parent_slot_id FROM chain ORDER BY depth`
            if (chain[0]?.id !== job.first_slot_id) return yield* refused("summary must cover a primary-parent chain")
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
            count = chain.length
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
          // What it is written with: the frozen request's images as the summarizer sends them; else
          // (no request was frozen) what the job's fork shows. A condensation's parts carry theirs.
          const versions = inputs.map((i) => i.versionId)
          const images =
            job.level > 1
              ? null
              : request
                ? yield* requestImages(sql, versions, request)
                : yield* shownImages(
                    sql,
                    versions,
                    lcmPath(
                      sql,
                      userId,
                      job.chat_id,
                      job.last_slot_id,
                      job.first_slot_id,
                      Number.MAX_SAFE_INTEGER,
                      job.audience_json === null ? undefined : audienceIds(job.audience_json)
                    ).pipe(
                      Effect.map((path) =>
                        path.flatMap((s) =>
                          inputs.some((i) => i.slotId === s.id) ? s.images.map((image) => image.mediaId) : []
                        )
                      )
                    )
                  )
          const id = uuidv7(),
            revisionId = uuidv7(),
            now = Date.now()
          yield* sql`INSERT INTO summary_revisions ${sql.insert({ id: revisionId, summary_id: id, rollout_id: rolloutId, content, token_count: tokensOf({ content }), origin: "generated", created_at: now })}`
          yield* sql`INSERT INTO summaries ${sql.insert({
            id,
            chat_id: job.chat_id,
            level: job.level,
            selected_revision_id: revisionId,
            first_slot_id: job.first_slot_id,
            last_slot_id: job.last_slot_id,
            slot_count: count,
            status,
            rollout_id: rolloutId,
            batch_id: job.batch_id,
            created_at: now,
            images_json: images,
            audience_json: job.audience_json
          })}`
          for (const [ordinal, input] of inputs.entries())
            yield* sql`INSERT INTO summary_inputs ${sql.insert({ summary_id: id, ordinal, slot_id: input.slotId, version_id: input.versionId, amend_count: input.amendCount })}`
          for (const [ordinal, child] of children.entries())
            yield* sql`INSERT INTO summary_parents ${sql.insert({ summary_id: id, ordinal, parent_id: child.summaryId, parent_revision_id: child.revisionId })}`
          yield* sql`UPDATE summaries SET sealed = 1 WHERE id = ${id}`
          for (const summaryId of supersede) {
            const protectedSummary = yield* readSummary(sql, userId, summaryId)
            if (protectedSummary.origin === "user" || protectedSummary.origin === "imported") continue
            yield* choose(job.chat_id, summaryId, "summary_superseded", id)
          }
          if (job.source_summary_id !== null) {
            const source = yield* readSummary(sql, userId, job.source_summary_id)
            if (source.origin === "generated" && source.revisionId === job.source_revision_id)
              for (const choice of yield* summaryChoices(sql, job.chat_id))
                if (choice.chosen_id === source.id && choice.summary_id !== choice.chosen_id)
                  yield* choose(job.chat_id, choice.summary_id, "summary_choice", id)
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
        }).pipe(inJobFork(sql, jobId), transaction(sql, "CompleteSummary")),
      EditSummary: ({ userId, summaryId, forkId, content, expectedRowVersion, commitDraft }) =>
        Effect.gen(function* () {
          const before = yield* current(userId, summaryId, expectedRowVersion)
          const revisionId = uuidv7()
          yield* sql`INSERT INTO summary_revisions ${sql.insert({ id: revisionId, summary_id: summaryId, content, token_count: tokensOf({ content }), origin: "user", created_at: Date.now() })}`
          yield* choose(before.chatId, summaryId, "summary_revision", revisionId)
          yield* choose(before.chatId, summaryId, "summary_choice", summaryId)
          const { recovered } = yield* bin.drafts.commit(userId, commitDraft, {
            targetKind: "summary_edit",
            targetId: summaryId,
            content,
            revision: revisionId
          })
          return { summary: yield* readSummary(sql, userId, summaryId), recovered }
        }).pipe(inSummaryFork(sql, userId, summaryId, forkId), transaction(sql, "EditSummary")),
      SelectSummaryRevision: ({ userId, summaryId, forkId, revisionId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const before = yield* current(userId, summaryId, expectedRowVersion)
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
            yield* choose(before.chatId, summaryId, "summary_choice", target)
          } else {
            yield* readSummary(sql, userId, summaryId, revisionId)
            yield* choose(before.chatId, summaryId, "summary_choice", summaryId)
          }
          yield* choose(before.chatId, target, "summary_revision", revisionId)
          return yield* readSummary(sql, userId, target)
        }).pipe(inSummaryFork(sql, userId, summaryId, forkId), transaction(sql, "SelectSummaryRevision"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  })
