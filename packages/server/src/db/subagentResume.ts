// Carrying a subagent on with its resumed reply (spec/SUBAGENTS.md §8): the stopped child's run
// goes on as a new child rollout of the resumed reply, for the same `agent` call, the way a
// resumed reply's rollout carries on from the stopped one (rolloutWrites.ts StartResumedVersion):
// the same handle, snapshot and model, the kept transcript, and the receipts of the calls kept,
// so a call it finished is answered from its receipt and never runs twice.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { ownedModel } from "./generationSettings.ts"
import { NotFound, type WriteOps } from "./ops.ts"
import { chainOf, replySubagents, spendOf } from "./subagents.ts"
import { transaction } from "./tx.ts"

interface Source {
  readonly agent_handle: string
  readonly status: string
  readonly connection_id: string | null
  readonly model_id: string | null
}

/** Its model must still be one of the user's own, as `StartSubagent` checks for a new one. */
const ownModel = (sql: SqlClient.SqlClient, userId: UserId, source: Source) =>
  Effect.gen(function* () {
    if (
      source.connection_id === null ||
      source.model_id === null ||
      !(yield* ownedModel(sql, userId, source.connection_id, source.model_id))
    )
      return yield* new NotFound({ entity: "model", id: source.model_id ?? "" })
  })

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
      branch,
      versionId
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
        const [source] = yield* sql<Source>`
          SELECT agent_handle, status, connection_id, model_id FROM rollouts
          WHERE id = ${sourceRolloutId} AND chat_id = ${parent.chat_id} AND spawned_by_call_id = ${callId}
            AND spawned_by_rollout_id IN (SELECT value FROM json_each(${JSON.stringify(chain)}))`
        if (!source) return { refused: "not_found" as const }
        // One still running is carried on by nothing else (a message's continuation, say).
        if (source.status === "running" || source.status === "created") return { refused: "running" as const }
        yield* ownModel(sql, userId, source)
        const now = Date.now()
        yield* sql`INSERT INTO rollouts (id, chat_id, fork_id, kind, status, slot_id, leaf_slot_id, parent_rollout_id,
            role, mode, connection_id, model_id, request_class, step_count, created_at, started_at, updated_at,
            spawned_by_rollout_id, spawned_by_call_id, agent_handle)
          SELECT ${rolloutId}, chat_id, fork_id, kind, 'running', NULL, leaf_slot_id, id, role, mode, connection_id,
            model_id, request_class, ${steps}, ${now}, ${now}, ${now}, ${parentRolloutId}, ${callId}, agent_handle
          FROM rollouts WHERE id = ${sourceRolloutId}`
        yield* sql`INSERT INTO rollout_payloads (rollout_id, context_snapshot_json, transcript_json)
          SELECT ${rolloutId}, ${versionId === undefined ? sql`context_snapshot_json` : sql`json_set(context_snapshot_json, '$.subagent.versionId', ${versionId})`},
            ${transcript} FROM rollout_payloads WHERE rollout_id = ${sourceRolloutId}`
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
      }).pipe(transaction(sql, "ResumeSubagent")),

    // A follow-up to a finished (or stopped) subagent (spec/SUBAGENTS.md §4): a new child rollout of
    // the run whose `message_agent` call sends it, carried on from that subagent (`parent_rollout_id`,
    // the built meaning) with the same handle, snapshot and model and the transcript given, so the
    // provider reads its earlier requests from cache and it remembers what it read. It counts toward
    // the run's subagents and their spend like a new one.
    ContinueSubagent: ({
      userId,
      parentRolloutId,
      callId,
      sourceRolloutId,
      rolloutId,
      transcript,
      steps,
      keptCalls,
      background,
      perRun,
      runCost,
      versionId
    }) =>
      Effect.gen(function* () {
        const [parent] = yield* sql<{
          readonly status: string
          readonly chat_id: string
          readonly spawned_by_rollout_id: string | null
        }>`
          SELECT r.status, r.chat_id, r.spawned_by_rollout_id FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${parentRolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!parent) return yield* new NotFound({ entity: "rollout", id: parentRolloutId })
        const [existing] = yield* sql<{ id: string; agent_handle: string }>`
          SELECT id, agent_handle FROM rollouts
          WHERE spawned_by_rollout_id = ${parentRolloutId} AND spawned_by_call_id = ${callId}`
        if (existing) return { rolloutId: existing.id, handle: existing.agent_handle, existing: true }
        if (parent.spawned_by_rollout_id !== null) return { refused: "not_found" as const }
        if (parent.status !== "running") return { refused: "not_running" as const }
        // A subagent of this run or one it carries on from, and not one still running.
        const chain = yield* chainOf(sql, parentRolloutId)
        const [source] = yield* sql<Source>`
          SELECT agent_handle, status, connection_id, model_id FROM rollouts
          WHERE id = ${sourceRolloutId} AND chat_id = ${parent.chat_id}
            AND spawned_by_rollout_id IN (SELECT value FROM json_each(${JSON.stringify(chain)}))`
        if (!source) return { refused: "not_found" as const }
        if (source.status === "running" || source.status === "created") return { refused: "running" as const }
        yield* ownModel(sql, userId, source)
        // Counted like a new one (§6.2: continuations count), per reply across its Stops and
        // Resumes; a child resumed with it doesn't count again.
        const reply = yield* replySubagents(sql, parentRolloutId)
        if (reply.filter((r) => !r.resumed).length >= (perRun ?? 16)) return { refused: "limit" as const }
        if (
          runCost !== undefined &&
          (yield* spendOf(
            sql,
            reply.map((r) => r.id)
          )).cost >= runCost
        )
          return { refused: "spent" as const }
        const now = Date.now()
        yield* sql`INSERT INTO rollouts (id, chat_id, fork_id, kind, status, slot_id, leaf_slot_id, parent_rollout_id,
            role, mode, connection_id, model_id, request_class, step_count, created_at, started_at, updated_at,
            spawned_by_rollout_id, spawned_by_call_id, agent_handle)
          SELECT ${rolloutId}, chat_id, fork_id, kind, 'running', NULL, leaf_slot_id, id, role, mode, connection_id,
            model_id, request_class, ${steps}, ${now}, ${now}, ${now}, ${parentRolloutId}, ${callId}, agent_handle
          FROM rollouts WHERE id = ${sourceRolloutId}`
        yield* sql`INSERT INTO rollout_payloads (rollout_id, context_snapshot_json, transcript_json)
          SELECT ${rolloutId}, json_set(context_snapshot_json, '$.subagent.continued', json('true'),
              '$.subagent.background', json(${background ? "true" : "false"}),
              '$.subagent.spawnedBy', ${parentRolloutId}, '$.subagent.callId', ${callId},
              '$.subagent.versionId', ${versionId ?? null}),
            ${transcript}
          FROM rollout_payloads WHERE rollout_id = ${sourceRolloutId}`
        for (const id of keptCalls)
          yield* sql`INSERT INTO rollout_receipts (rollout_id, tool_call_id, result_json, is_error, created_at)
            SELECT ${rolloutId}, tool_call_id, result_json, is_error, ${now} FROM rollout_receipts
            WHERE rollout_id = ${sourceRolloutId} AND tool_call_id = ${id}`
        return { rolloutId, handle: source.agent_handle, existing: false }
      }).pipe(transaction(sql, "ContinueSubagent"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
