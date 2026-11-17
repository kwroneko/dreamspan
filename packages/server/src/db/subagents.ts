// Subagents' storage (spec/SUBAGENTS.md §11): starting a child rollout of a running run, and
// reading a run's children, always through the parent's run chain (its `parent_rollout_id`
// links: resumes and carried-on turns), so a child is found only from the reply it belongs to.
// Owner-scoped like every rollout read; the migration 0003_subagents holds the link.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ChildStep, SubagentRow, SubagentStatus } from "@rp/shared/agent.ts"
import type { InspectorUsage } from "@rp/shared/inspectorApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { VersionId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { stepsOf } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { transcriptEntries } from "./transcriptEntries.ts"
import { ownedModel } from "./generationSettings.ts"
import { rolloutUsage } from "./inspectorReads.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

/** At most this many subagents per parent run, continuations included (spec/SUBAGENTS.md §6.2). */
const SUBAGENTS_PER_RUN = 16

/** What a child's snapshot freezes beside its `agent` block (spec/SUBAGENTS.md §2.2). */
export interface SubagentSnapshot {
  readonly type: string
  readonly typeLabel: string
  readonly task: string
  readonly name?: string
  readonly alias: string
  /** The model's name as the row shows it. */
  readonly model: string
  readonly instructions: string
  readonly context: "task"
  readonly spawnedBy: string
  readonly callId: string
}

/** The rollouts a run carries on from, itself first: where its earlier calls' children were started. */
const chainOf = (sql: SqlClient.SqlClient, rolloutId: string) =>
  sql<{ id: string }>`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT ${rolloutId}, 0
      UNION ALL
      SELECT r.parent_rollout_id, chain.depth + 1 FROM rollouts r JOIN chain ON r.id = chain.id
      WHERE r.parent_rollout_id IS NOT NULL AND chain.depth < 100000
    )
    SELECT id FROM chain`.pipe(Effect.map((rows) => rows.map((r) => r.id)))

interface ChildRecord {
  readonly id: string
  readonly handle: string
  readonly status: string
  readonly spawned_by_rollout_id: string
  readonly spawned_by_call_id: string
  readonly step_count: number
  readonly created_at: number
  readonly completed_at: number | null
  readonly error: string | null
  readonly snapshot: string | null
  readonly transcript: string | null
  readonly requests: number
  readonly cost: number | null
  readonly currency: string | null
  readonly unpriced: number
}

/** A run chain's children, newest first; `calls` narrows them to those calls. */
const childrenOf = (sql: SqlClient.SqlClient, chain: ReadonlyArray<string>, calls?: ReadonlyArray<string>) =>
  sql<ChildRecord>`
    SELECT r.id, r.agent_handle AS handle, r.status, r.spawned_by_rollout_id, r.spawned_by_call_id, r.step_count,
      r.created_at, r.completed_at, r.error,
      p.context_snapshot_json AS snapshot, p.transcript_json AS transcript,
      (SELECT count(*) FROM llm_requests q WHERE q.rollout_id = r.id) AS requests,
      (SELECT sum(q.cost) FROM llm_requests q WHERE q.rollout_id = r.id) AS cost,
      (SELECT min(q.cost_currency) FROM llm_requests q WHERE q.rollout_id = r.id) AS currency,
      (SELECT count(*) FROM llm_requests q WHERE q.rollout_id = r.id AND q.cost IS NULL) AS unpriced
    FROM rollouts r LEFT JOIN rollout_payloads p ON p.rollout_id = r.id
    WHERE r.spawned_by_rollout_id IN (SELECT value FROM json_each(${JSON.stringify(chain)}))
      ${calls ? sql`AND r.spawned_by_call_id IN (SELECT value FROM json_each(${JSON.stringify(calls)}))` : sql``}
    ORDER BY r.created_at DESC, r.id DESC`

const parse = <A>(json: string | null, fallback: A): A => {
  if (json === null) return fallback
  try {
    return JSON.parse(json) as A
  } catch {
    return fallback
  }
}

/** A rollout's status as a subagent's row says it; an interrupted one (a restart) was stopped. */
const statusOf = (status: string, steps: ReadonlyArray<ChildStep>): SubagentStatus =>
  status === "running" || status === "created"
    ? steps.some((s) => s.kind === "tool" && s.status === "waiting")
      ? "waiting"
      : "running"
    : status === "completed"
      ? "done"
      : status === "failed"
        ? "failed"
        : "stopped"

/** The last text a transcript's model turns hold: what a subagent had of its report. */
const lastText = (messages: ReadonlyArray<AgentMessage>): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const text = m.content.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text] : [])).join("")
    if (text) return text
  }
  return null
}

/** A child as its row shows it, from its rollout, snapshot, transcript and ledger rows. */
const rowOf = (r: ChildRecord): SubagentRow => {
  const snapshot = parse<{
    readonly subagent?: SubagentSnapshot
    readonly agent?: { readonly tools?: ReadonlyArray<FrozenTool> }
  }>(r.snapshot, {})
  const messages = parse<ReadonlyArray<AgentMessage>>(r.transcript, [])
  const running = r.status === "running" || r.status === "created"
  const steps = stepsOf(messages, snapshot.agent?.tools ?? [], !running).map((s) => {
    if (s.kind !== "tool" || !("subagent" in s)) return s as ChildStep
    const { subagent: _subagent, ...step } = s
    return step
  })
  const sub = snapshot.subagent
  return {
    rolloutId: r.id,
    handle: r.handle,
    type: sub?.type ?? "",
    typeLabel: sub?.typeLabel ?? "Subagent",
    ...(sub?.name ? { name: sub.name } : {}),
    task: sub?.task ?? "",
    alias: sub?.alias ?? "same",
    model: sub?.model ?? "",
    status: statusOf(r.status, steps),
    steps,
    count: r.step_count,
    ms: r.completed_at === null ? null : Math.max(0, r.completed_at - r.created_at),
    cost:
      !running && r.requests > 0 && r.unpriced === 0 && r.cost !== null && r.currency !== null
        ? { amount: r.cost, currency: r.currency }
        : null
  }
}

/** The run behind a version, if it's the user's. */
const versionRollout = (sql: SqlClient.SqlClient, userId: UserId, versionId: VersionId) =>
  sql<{ rollout_id: string | null }>`
    SELECT v.rollout_id FROM versions v JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
    WHERE v.id = ${versionId} AND c.owner_user_id = ${userId}
      AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
    Effect.flatMap(([row]) =>
      row?.rollout_id ? Effect.succeed(row.rollout_id) : Effect.fail(new NotFound({ entity: "version", id: versionId }))
    )
  )

/** A subagent of the version's run chain, by id. */
const childOfVersion = (sql: SqlClient.SqlClient, userId: UserId, versionId: VersionId, rolloutId: string) =>
  Effect.gen(function* () {
    const chain = yield* chainOf(sql, yield* versionRollout(sql, userId, versionId))
    const child = (yield* childrenOf(sql, chain)).find((c) => c.id === rolloutId)
    if (!child) return yield* new NotFound({ entity: "subagent", id: rolloutId })
    return child
  })

/**
 * A run's tool steps with the subagents their `agent` calls started (spec/SUBAGENTS.md §7):
 * for the stored steps, read in the same transaction as them.
 */
export const withSubagents = <S extends { readonly kind: string }>(
  sql: SqlClient.SqlClient,
  rolloutId: string,
  steps: ReadonlyArray<S>
) =>
  Effect.gen(function* () {
    const calls = steps.flatMap((s) =>
      s.kind === "tool" && (s as unknown as { tool: string }).tool === "agent"
        ? [(s as unknown as { id: string }).id]
        : []
    )
    if (calls.length === 0) return steps
    const children = yield* childrenOf(sql, yield* chainOf(sql, rolloutId), calls)
    const byCall = new Map<string, ChildRecord>()
    for (const child of children) if (!byCall.has(child.spawned_by_call_id)) byCall.set(child.spawned_by_call_id, child)
    return steps.map((s) => {
      const child = s.kind === "tool" ? byCall.get((s as unknown as { id: string }).id) : undefined
      return child ? { ...s, subagent: rowOf(child) } : s
    })
  })

export const makeSubagentReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    FindSubagent: ({ userId, rolloutId, toolCallId }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ id: string }>`SELECT r.id FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const [child] = yield* childrenOf(sql, yield* chainOf(sql, rolloutId), [toolCallId])
        if (!child) return null
        return {
          rolloutId: child.id,
          handle: child.handle,
          status: child.status,
          partial: lastText(parse<ReadonlyArray<AgentMessage>>(child.transcript, [])),
          row: rowOf(child)
        }
      }).pipe(query("FindSubagent")),

    SubagentStatus: ({ userId, versionId, rolloutId }) =>
      childOfVersion(sql, userId, versionId, rolloutId).pipe(
        Effect.map((child) => child.status),
        query("SubagentStatus")
      ),

    SubagentRun: ({ userId, versionId, rolloutId }) =>
      Effect.gen(function* () {
        const child = yield* childOfVersion(sql, userId, versionId, rolloutId)
        const snapshot = parse<{
          readonly subagent?: SubagentSnapshot
          readonly agent?: { readonly tools?: ReadonlyArray<FrozenTool>; readonly turnCap?: number }
        }>(child.snapshot, {})
        const tools = snapshot.agent?.tools ?? []
        const messages = parse<ReadonlyArray<AgentMessage>>(child.transcript, [])
        const requests = yield* rolloutUsage(sql, userId, child.id)
        return {
          row: rowOf(child),
          startedBy: { versionId, toolCallId: child.spawned_by_call_id },
          instructions: snapshot.subagent?.instructions ?? "",
          tools: tools.map((t) => ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
            ...(t.capability ? { capability: t.capability } : {}),
            ...(t.titleField ? { titleField: t.titleField } : {}),
            effect: t.effect
          })),
          // The task is the first message after the request; it shows apart, as the row's.
          entries: transcriptEntries(messages, tools.length, snapshot.agent?.turnCap ?? Number.MAX_SAFE_INTEGER),
          requests: requests.map((r): InspectorUsage => ({
            id: r.id as InspectorUsage["id"],
            estimatedInput: r.estimated_input,
            status: r.status,
            startedAt: r.started_at,
            firstTokenAt: r.first_token_at,
            endedAt: r.ended_at,
            usageSource: r.usage_source,
            counts: {
              inputUncached: r.input_uncached,
              cacheRead: r.cache_read,
              cacheWrite: r.cache_write,
              output: r.output
            },
            cost: r.cost === null ? null : { amount: r.cost, currency: r.cost_currency! }
          })),
          error: child.error
        }
      }).pipe(query("SubagentRun"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeSubagentWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    StartSubagent: ({ userId, parentRolloutId, callId, rolloutId, type, connectionId, modelId, snapshot }) =>
      Effect.gen(function* () {
        const [parent] = yield* sql<{
          readonly chat_id: string
          readonly kind: string
          readonly status: string
          readonly fork_id: string | null
          readonly leaf_slot_id: string | null
          readonly spawned_by_rollout_id: string | null
        }>`SELECT r.chat_id, r.kind, r.status, r.fork_id, r.leaf_slot_id, r.spawned_by_rollout_id
          FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${parentRolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!parent) return yield* new NotFound({ entity: "rollout", id: parentRolloutId })
        // The same call starts one subagent, whatever asks twice.
        const [existing] = yield* sql<{ id: string; agent_handle: string }>`
          SELECT id, agent_handle FROM rollouts
          WHERE spawned_by_rollout_id = ${parentRolloutId} AND spawned_by_call_id = ${callId}`
        if (existing) return { rolloutId: existing.id, handle: existing.agent_handle, existing: true }
        if (parent.spawned_by_rollout_id !== null) return { refused: "nested" as const }
        if (parent.status !== "running") return { refused: "not_running" as const }
        if (!(yield* ownedModel(sql, userId, connectionId, modelId)))
          return yield* new NotFound({ entity: "model", id: modelId })
        const [started] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM rollouts WHERE spawned_by_rollout_id = ${parentRolloutId}`
        if (started!.n >= SUBAGENTS_PER_RUN) return { refused: "limit" as const }
        // Numbered across the run chain, so a handle names one child wherever the run carried on.
        const chain = yield* chainOf(sql, parentRolloutId)
        const [same] = yield* sql<{ n: number }>`
          SELECT count(*) AS n FROM rollouts
          WHERE spawned_by_rollout_id IN (SELECT value FROM json_each(${JSON.stringify(chain)}))
            AND agent_handle LIKE ${`${type}-%`}`
        const handle = `${type}-${same!.n + 1}`
        const now = Date.now()
        yield* sql`INSERT INTO rollouts ${sql.insert({
          id: rolloutId,
          chat_id: parent.chat_id,
          fork_id: parent.fork_id,
          kind: parent.kind,
          status: "running",
          slot_id: null,
          leaf_slot_id: parent.leaf_slot_id,
          role: "subagent",
          mode: "subagent",
          connection_id: connectionId,
          model_id: modelId,
          request_class: "interactive",
          created_at: now,
          started_at: now,
          updated_at: now,
          spawned_by_rollout_id: parentRolloutId,
          spawned_by_call_id: callId,
          agent_handle: handle
        })}`
        yield* sql`INSERT INTO rollout_payloads ${sql.insert({ rollout_id: rolloutId, context_snapshot_json: snapshot })}`
        return { rolloutId, handle, existing: false }
      }).pipe(transaction(sql, "StartSubagent"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
