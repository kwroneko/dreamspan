// Carrying a subagent on with its resumed reply (spec/SUBAGENTS.md §8): the stopped child's run
// goes on as a new child rollout of the resumed reply, for the same `agent` call, the way a
// resumed reply's rollout carries on from the stopped one (rolloutWrites.ts StartResumedVersion):
// the same handle, snapshot and model, the kept transcript, and the receipts of the calls kept,
// so a call it finished is answered from its receipt and never runs twice.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, type WriteOps } from "./ops.ts"
import { chainOf } from "./subagents.ts"
import { transaction } from "./tx.ts"

export const makeSubagentResumeHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ResumeSubagent: ({
      userId,
      parentRolloutId,
      callId,
      sourceRolloutId,
      rolloutId,
      transcript,
      steps,
      keptCalls,
      branch
    }) =>
      Effect.gen(function* () {
        const [parent] = yield* sql<{ readonly status: string; readonly chat_id: string }>`
          SELECT r.status, r.chat_id FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${parentRolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!parent) return yield* new NotFound({ entity: "rollout", id: parentRolloutId })
        const [existing] = yield* sql<{ id: string; agent_handle: string }>`
          SELECT id, agent_handle FROM rollouts
          WHERE spawned_by_rollout_id = ${parentRolloutId} AND spawned_by_call_id = ${callId}`
        if (existing) return { rolloutId: existing.id, handle: existing.agent_handle, existing: true }
        if (parent.status !== "running") return { refused: "not_running" as const }
        // Only this call's own subagent, started on the run this one carries on from.
        const chain = yield* chainOf(sql, parentRolloutId)
        const [source] = yield* sql<{ readonly agent_handle: string }>`
          SELECT agent_handle FROM rollouts
          WHERE id = ${sourceRolloutId} AND chat_id = ${parent.chat_id} AND spawned_by_call_id = ${callId}
            AND spawned_by_rollout_id IN (SELECT value FROM json_each(${JSON.stringify(chain)}))`
        if (!source) return { refused: "not_found" as const }
        const now = Date.now()
        yield* sql`INSERT INTO rollouts (id, chat_id, fork_id, kind, status, slot_id, leaf_slot_id, parent_rollout_id,
            role, mode, connection_id, model_id, request_class, step_count, created_at, started_at, updated_at,
            spawned_by_rollout_id, spawned_by_call_id, agent_handle)
          SELECT ${rolloutId}, chat_id, fork_id, kind, 'running', NULL, leaf_slot_id, id, role, mode, connection_id,
            model_id, request_class, ${steps}, ${now}, ${now}, ${now}, ${parentRolloutId}, ${callId}, agent_handle
          FROM rollouts WHERE id = ${sourceRolloutId}`
        yield* sql`INSERT INTO rollout_payloads (rollout_id, context_snapshot_json, transcript_json)
          SELECT ${rolloutId}, context_snapshot_json, ${transcript} FROM rollout_payloads WHERE rollout_id = ${sourceRolloutId}`
        for (const id of keptCalls)
          yield* sql`INSERT INTO rollout_receipts (rollout_id, tool_call_id, result_json, is_error, created_at)
            SELECT ${rolloutId}, tool_call_id, result_json, is_error, ${now} FROM rollout_receipts
            WHERE rollout_id = ${sourceRolloutId} AND tool_call_id = ${id}`
        if (branch)
          yield* sql`INSERT INTO rollout_branches ${sql.insert({
            rollout_id: rolloutId,
            branch_no: 1,
            fork_index: (JSON.parse(transcript) as Array<unknown>).length,
            reason: "resume",
            messages_json: branch.messages,
            created_at: now
          })}`
        return { rolloutId, handle: source.agent_handle, existing: false }
      }).pipe(transaction(sql, "ResumeSubagent"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
