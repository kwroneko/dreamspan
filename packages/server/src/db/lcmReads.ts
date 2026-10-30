import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { ContextDisplay } from "@rp/shared/inspectorApi.ts"
import type { WireContext } from "../assembler/types.ts"
import { tokensOf } from "../assembler/st.ts"
import { toLlmRequest, type LlmRequestRow } from "./providers.ts"
import { inSummaryFork } from "./lcmFork.ts"
import { effectiveOverride } from "./forkState.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { Summary } from "@rp/shared/lcm.ts"
import { shownIn, shownVersionDeletedIn, slotDeletedIn, viewAt } from "./forkState.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"
import { positionOf } from "./displayPath.ts"
import { lcmView, type LcmView } from "./lcmDisplay.ts"

export const readSummary = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  id: string,
  revision?: string,
  memo = new Map<string, Summary>(),
  view?: LcmView
) => {
  let views = view === undefined ? [] : [view]
  const read = (summaryId: string): Effect.Effect<Summary, NotFound | import("effect/sql").SqlError.SqlError> =>
    Effect.gen(function* () {
      const cached = memo.get(summaryId)
      if (cached) return cached
      const [owner] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM summaries WHERE id=${summaryId}`
      const fork = yield* viewAt(sql, owner?.chat_id ?? "", null)
      let shown = views.find((v) => v.fork === fork)
      if (shown === undefined) {
        shown = yield* lcmView(sql, owner?.chat_id ?? "", fork)
        views = [...views, shown]
      }
      const [row] = yield* sql<{
        id: string
        chat_id: string
        level: number
        first_slot_id: string
        last_slot_id: string
        slot_count: number
        selected_revision_id: string
        row_version: number
        status: Summary["status"]
        error_json: string | null
        batch_id: string | null
        content: string
        token_count: number
        origin: Summary["origin"]
        revision_id: string
        revision_number: number
        first_depth: number
        last_depth: number
        first_chain: string
        last_chain: string
      }>`SELECT s.*, max(s.row_version,coalesce(ro.seq,0),coalesce(co.seq,0)) AS row_version, r.id AS revision_id, r.content, r.token_count, r.origin, (SELECT count(*) FROM summary_revisions p WHERE p.summary_id = s.id AND p.seq <= r.seq) AS revision_number, a.depth AS first_depth, b.depth AS last_depth, a.chain_id AS first_chain, b.chain_id AS last_chain
          FROM summaries s JOIN chats c ON c.id = s.chat_id
          LEFT JOIN fork_overrides ro ON ro.id=${effectiveOverride(sql, "summary_revision", fork, "s.id")}
          LEFT JOIN fork_overrides co ON co.id=${effectiveOverride(sql, "summary_choice", fork, "s.id")}
          JOIN summary_revisions r ON r.summary_id = s.id AND r.id = coalesce(${summaryId === id ? (revision ?? null) : null}, ro.value_id, s.selected_revision_id)
          JOIN slots a ON a.id = s.first_slot_id JOIN slots b ON b.id = s.last_slot_id
          WHERE s.id = ${summaryId} AND s.sealed = 1 AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
      if (!row) return yield* new NotFound({ entity: "summary", id: summaryId })
      // Fresh in the fork in view: its inputs are what that fork shows (spec/FORK-INDEPENDENCE-DELTA.md §3).
      const inputs = yield* sql<{
        slot_id: string
        version_id: string | null
        amend_count: number
        effective: string | null
        current_amends: number
        replaced_with_summaries: number
      }>`
        SELECT i.*, EXISTS(SELECT 1 FROM fork_overrides o WHERE o.id=${effectiveOverride(sql, "replace", fork, "CASE WHEN iv.fork_id IS NULL THEN i.version_id ELSE iv.source_version_id END")}
          AND o.value_id=v.id AND o.summaries_done=1 AND EXISTS (
            SELECT 1 FROM changeset_items ci, json_each(ci.after_json, '$.preservedInputs') p
            WHERE ci.changeset_id=o.changeset_id AND ci.target_kind='version_replace'
              AND ci.target_id=o.target_id AND ci.after_json ->> '$.id'=v.id
              AND p.value ->> '$.id'=i.version_id AND p.value ->> '$.amends'=i.amend_count)) AS replaced_with_summaries, CASE WHEN NOT ${slotDeletedIn(sql, fork, "s")} AND ${contextExcludedIn(sql, fork)} = 0
          AND NOT ${shownVersionDeletedIn(sql, fork, "v")} AND v.status NOT IN ('generating', 'failed') AND length(v.content) > 0
          THEN v.id ELSE NULL END AS effective, (SELECT count(*) FROM version_history h WHERE h.version_id = v.id) AS current_amends
        FROM summary_inputs i JOIN slots s ON s.id = i.slot_id LEFT JOIN versions iv ON iv.id=i.version_id LEFT JOIN versions v ON v.id = ${shownIn(sql, fork, "s")}
        WHERE i.summary_id = ${summaryId} ORDER BY i.ordinal`
      const children = yield* sql<{
        parent_id: string
        parent_revision_id: string
      }>`SELECT parent_id, parent_revision_id
        FROM summary_parents WHERE summary_id = ${summaryId} ORDER BY ordinal`
      let fresh = inputs.every(
        (i) =>
          (i.version_id === i.effective && (i.version_id === null || i.amend_count === i.current_amends)) ||
          (i.effective !== null && i.replaced_with_summaries === 1 && i.current_amends === 0)
      )
      // An explicit rerun establishes an active generated replacement. Old lineage remains
      // pinned for replay, while live generated ancestors must incorporate the replacement.
      const [replacement] = yield* sql`SELECT 1 FROM summarization_jobs j JOIN summaries s ON s.id=j.result_summary_id
        WHERE j.source_summary_id=${summaryId} AND j.source_revision_id=${row.revision_id}
          AND (j.fork_id IS NULL OR j.fork_id=${fork}) AND j.explicit_requested=1 AND j.status='complete' AND s.status IN ('complete','truncated')`
      const [choice] = yield* sql`SELECT 1 FROM summaries s LEFT JOIN lcm_summary_choices b ON b.summary_id=s.id
          LEFT JOIN fork_overrides o ON o.id=${effectiveOverride(sql, "summary_choice", fork, "s.id")}
          WHERE s.id=${summaryId} AND coalesce(o.value_id,b.chosen_id,s.id)<>s.id`
      if (choice || (replacement && row.origin === "generated")) fresh = false
      for (const child of children) {
        const parent = yield* read(child.parent_id)
        const [sameGroup] =
          row.origin === "changeset" && parent.origin === "changeset"
            ? yield* sql`SELECT 1
          FROM changeset_items a JOIN changesets ac ON ac.id=a.changeset_id
          JOIN changeset_items b ON b.target_kind='summary_revision' JOIN changesets bc ON bc.id=b.changeset_id
          WHERE a.target_kind='summary_revision' AND a.target_id=${row.id} AND a.after_json ->> '$.id'=${row.revision_id}
            AND b.target_id=${parent.id} AND b.after_json ->> '$.id'=${parent.revisionId} AND ac.group_id=bc.group_id
            AND a.after_json ->> '$.applicationId'=b.after_json ->> '$.applicationId' LIMIT 1`
            : []
        fresh &&= parent.fresh && (parent.revisionId === child.parent_revision_id || sameGroup !== undefined)
      }
      // In a fork that shows inserted slots, its numbers are positions, and a slot shown between
      // its first and last that it doesn't cover is an insertion inside it: stale, as after an
      // edit there (spec/MESSAGE-INSERT.md §3.4).
      let from = row.first_depth + 1,
        to = row.last_depth + 1
      if (shown.pieces !== null) {
        const first = positionOf(shown.pieces, {
          id: row.first_slot_id,
          chainId: row.first_chain,
          depth: row.first_depth
        })
        const last = positionOf(shown.pieces, { id: row.last_slot_id, chainId: row.last_chain, depth: row.last_depth })
        if (first !== null && last !== null && last >= first) {
          from = first + 1
          to = last + 1
          if (to - from + 1 > row.slot_count) fresh = false
        }
      }
      const summary = Schema.decodeUnknownSync(Summary)({
        id: row.id,
        chatId: row.chat_id,
        level: row.level,
        firstSlotId: row.first_slot_id,
        lastSlotId: row.last_slot_id,
        from,
        to,
        slotCount: row.slot_count,
        revisionNumber: row.revision_number,
        revisionId: row.revision_id,
        content: row.content,
        tokens: row.token_count,
        origin: row.origin,
        status:
          (yield* sql`SELECT 1 FROM summaries s JOIN fork_overrides o ON o.id=${effectiveOverride(sql, "summary_superseded", fork, "s.id")} WHERE s.id=${summaryId}`)
            .length
            ? "superseded"
            : row.status,
        error: row.error_json,
        batchId: row.batch_id,
        rowVersion: row.row_version,
        fresh,
        inputs: inputs.map((i) => ({ slotId: i.slot_id, versionId: i.version_id, amendCount: i.amend_count })),
        children: children.map((p) => ({ summaryId: p.parent_id, revisionId: p.parent_revision_id }))
      })
      memo.set(summaryId, summary)
      return summary
    })
  return read(id)
}

export const makeLcmReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    GetSummaryDetails: ({ userId, summaryId }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          chat_id: string
          fork_id: string | null
          rollout_id: string | null
          job_id: string | null
          attempts: number | null
          model: string | null
          started_at: number | null
          completed_at: number | null
          sent: string | null
        }>`SELECT s.chat_id,r.fork_id,s.rollout_id,j.id AS job_id,j.attempts,m.model_key AS model,
          r.started_at,r.completed_at,p.sent_context_json AS sent
          FROM summaries s JOIN chats c ON c.id=s.chat_id
          LEFT JOIN rollouts r ON r.id=s.rollout_id
          LEFT JOIN rollout_payloads p ON p.rollout_id=r.id
          LEFT JOIN models m ON m.id=r.model_id
          LEFT JOIN summarization_jobs j ON j.id=(SELECT id FROM summarization_jobs
            WHERE result_summary_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)
          WHERE s.id=${summaryId} AND c.owner_user_id=${userId} AND c.deleted_at IS NULL`
        if (!row) return yield* new NotFound({ entity: "summary", id: summaryId })
        const requests =
          row.rollout_id === null
            ? []
            : yield* sql<LlmRequestRow>`SELECT * FROM llm_requests
          WHERE rollout_id=${row.rollout_id} AND owner_user_id=${userId} ORDER BY started_at,id`
        const wire = row.sent ? (JSON.parse(row.sent) as WireContext) : null
        // Project the sanitized capture explicitly: transport metadata, digests and raw usage stay in storage.
        const request: ContextDisplay | null = wire?.display
          ? {
              ...wire.display,
              samplers: wire.samplers,
              messages: wire.messages.map((message) => ({
                role: message.role,
                name: message.name ?? null,
                content: message.content,
                ...(message.prefill ? { prefill: message.prefill } : {}),
                tokens: tokensOf(message),
                sources: message.sources ?? [],
                ...(message.parts ? { parts: message.parts } : {}),
                ...(message.groups ? { groups: message.groups } : {}),
                breakpoint: message.breakpoint ?? null
              }))
            }
          : null
        return {
          chatId: row.chat_id as ChatId,
          forkId: row.fork_id as ForkId | null,
          jobId: row.job_id,
          attempts: row.attempts,
          model:
            requests.findLast((request) => request.purpose === "summarize" || request.purpose === "condense")
              ?.model_key ??
            row.model ??
            wire?.display?.model?.model ??
            null,
          startedAt: row.started_at,
          endedAt: row.completed_at,
          requests: requests.map(toLlmRequest),
          request
        }
      }).pipe(query("GetSummaryDetails")),
    GetSummary: ({ userId, summaryId, forkId }) =>
      readSummary(sql, userId, summaryId).pipe(inSummaryFork(sql, userId, summaryId, forkId), query("GetSummary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
