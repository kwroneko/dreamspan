import { historySummaryRevision } from "./historyShared.ts"
import { effectiveOverride } from "./forkState.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
import { Summary } from "@rp/shared/lcm.ts"
import { shownIn, shownVersionDeletedIn, slotDeletedIn, viewAt } from "./forkState.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const readSummary = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  id: string,
  revision?: string,
  memo = new Map<string, Summary>()
) => {
  const read = (summaryId: string): Effect.Effect<Summary, NotFound | import("effect/sql").SqlError.SqlError> =>
    Effect.gen(function* () {
      const cached = memo.get(summaryId)
      if (cached) return cached
      const [identity] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM summaries WHERE id=${summaryId}`
      const fork = yield* viewAt(sql, identity?.chat_id ?? "", null)
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
      }>`SELECT s.*, r.id AS revision_id, r.content, r.token_count, r.origin, (SELECT count(*) FROM summary_revisions p WHERE p.summary_id = s.id AND p.seq <= r.seq) AS revision_number, a.depth AS first_depth, b.depth AS last_depth
          FROM summaries s JOIN chats c ON c.id = s.chat_id
          JOIN summary_revisions r ON r.summary_id = s.id AND r.id = coalesce(${summaryId === id ? (revision ?? null) : null}, ${historySummaryRevision(sql, fork ?? "", "s")})
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
          AND j.explicit_requested=1 AND j.status='complete' AND s.status IN ('complete','truncated')`
      const [choice] =
        yield* sql`SELECT 1 FROM lcm_summary_choices WHERE summary_id=${summaryId} AND chosen_id<>summary_id`
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
      const summary = Schema.decodeUnknownSync(Summary)({
        id: row.id,
        chatId: row.chat_id,
        level: row.level,
        firstSlotId: row.first_slot_id,
        lastSlotId: row.last_slot_id,
        from: row.first_depth + 1,
        to: row.last_depth + 1,
        slotCount: row.slot_count,
        revisionNumber: row.revision_number,
        revisionId: row.revision_id,
        content: row.content,
        tokens: row.token_count,
        origin: row.origin,
        status: row.status,
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
    GetSummary: ({ userId, summaryId }) => readSummary(sql, userId, summaryId).pipe(query("GetSummary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
