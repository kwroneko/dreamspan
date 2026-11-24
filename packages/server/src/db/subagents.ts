// Subagents' storage (spec/SUBAGENTS.md §11): starting a child rollout of a running run, and
// reading a run's children, always through the parent's run chain (its `parent_rollout_id`
// links: resumes and carried-on turns), so a child is found only from the reply it belongs to.
// Owner-scoped like every rollout read; the migration 0003_subagents holds the link.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ChildStep, SubagentRow, SubagentStatus } from "@dreamspan/shared/agent.ts"
import type { InspectorUsage } from "@dreamspan/shared/inspectorApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { VersionId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { forkStart } from "../agent/messages.ts"
import { stepsOf } from "../agent/steps.ts"
import type { FrozenTool } from "../agent/tools.ts"
import { transcriptEntries } from "./transcriptEntries.ts"
import { ownedModel } from "./generationSettings.ts"
import { rolloutUsage } from "./inspectorReads.ts"
import { retainedChildRuns, resumeLineage } from "./subagentEffects.ts"
import { LIMIT_STOP } from "@dreamspan/shared/subagents.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"

/** At most this many subagents per parent run, continuations included (spec/SUBAGENTS.md §6.2). */
const SUBAGENTS_PER_RUN = 16

/** What a child's snapshot freezes beside its `agent` block (spec/SUBAGENTS.md §2.2). */
export interface SubagentSnapshot {
  readonly type: string
  readonly typeLabel: string
  readonly typeExplanation?: string
  readonly task: string
  readonly name?: string
  readonly alias: string
  /** The model's name as the row shows it. */
  readonly model: string
  /** The reasoning level its requests asked for (§5.1); absent: none, the model's default. */
  readonly effort?: string
  readonly instructions: string
  /** What it sees (spec/SUBAGENTS.md §2.3): its task alone, or its parent's conversation and then its task. */
  readonly context: "task" | "fork"
  /**
   * A fork's request as its parent's was sent: the parent's tool definitions on the wire and as
   * frozen, and its cache layout, so a resumed or continued fork sends the same prefix the same way.
   */
  readonly fork?: {
    readonly wireTools: ReadonlyArray<import("@earendil-works/pi-ai").Tool>
    readonly offered: ReadonlyArray<FrozenTool>
    /** Its parent's cache layout: where breakpoints go, and the prefix's verbatim recent part. */
    readonly checkpoints?: ReadonlyArray<number>
    readonly recentPrefix?: number
  }
  readonly spawnedBy: string
  readonly callId: string
  /** The parent's message that holds the call: where the child's chat state goes (§8). */
  readonly versionId?: string
  /** It ran in the background: the reply went on, and its report came later (§3.2). */
  readonly background?: boolean
  /** It carries a finished subagent on with the parent's message (`message_agent`, §4). */
  readonly continued?: boolean
  /**
   * Where it works on files (spec/SUBAGENTS.md §3.3): the folder it starts in (`start`), the
   * folder its file tools stay inside (`root`, a copy's), and the copy itself, made before it
   * started. What became of the copy is its run's `COPY_CALL` receipt.
   */
  readonly workspace?: SubagentWorkspaceRecord
  /** Its limits, as they applied (spec/SUBAGENTS.md §6.2); absent on SA1's children. */
  readonly caps?: {
    readonly requests: number
    readonly tokens: number
    readonly cost: number
    readonly minutes: number
  }
}

/** A subagent's working folder, as its snapshot keeps it (spec/SUBAGENTS.md §3.3). */
export interface SubagentWorkspaceRecord {
  readonly start: string
  readonly root?: string
  readonly copy?: SubagentCopyRecord
}

/** An isolated copy: where, of what, and how it was made. */
export interface SubagentCopyRecord {
  /** The copy, under /files/.subagents. */
  readonly path: string
  /** The folder it copies (the reply's working folder). */
  readonly from: string
  /** `git`: a worktree of the repository at `top` on `branch`, made at commit `base`. */
  readonly kind: "git" | "files"
  readonly top?: string
  readonly branch?: string
  readonly base?: string
  /** The file copy before the subagent started. */
  readonly fingerprint?: string
  /** When the subagent ended: true, it had changes and stays; false, it was removed. */
  readonly kept?: boolean
}

/**
 * The receipt a subagent's run records when it ends with a copy (its outcome, `{ kept }`), under
 * this call id of its own; a kept copy is a `subagent.copy` effect there too, listed in Changes.
 */
export const COPY_CALL = "subagent-copy"

/** The rollouts a run carries on from, itself first: where its earlier calls' children were started. */
export const chainOf = (sql: SqlClient.SqlClient, rolloutId: string) =>
  sql<{ id: string }>`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT ${rolloutId}, 0
      UNION ALL
      SELECT r.parent_rollout_id, chain.depth + 1 FROM rollouts r JOIN chain ON r.id = chain.id
      WHERE r.parent_rollout_id IS NOT NULL AND chain.depth < 100000
    )
    SELECT id FROM chain`.pipe(Effect.map((rows) => rows.map((r) => r.id)))

/**
 * The calls a run's transcript holds, for a causal lookup (§4): each with whether it has a result
 * and the subagent that result names (`details.subagent`, kept with the result).
 */
export interface HeldCall {
  readonly id: string
  readonly result: boolean
  readonly subagent: string | null
}

export const heldCalls = (messages: ReadonlyArray<AgentMessage>): ReadonlyArray<HeldCall> => {
  const results = new Map<string, string | null>()
  for (const m of messages)
    if (m.role === "toolResult") {
      const named = (m.details as { subagent?: { rolloutId?: unknown } } | null | undefined)?.subagent?.rolloutId
      results.set(m.toolCallId, typeof named === "string" ? named : null)
    }
  return messages.flatMap((m) =>
    m.role === "assistant"
      ? m.content.flatMap((p) =>
          p.type === "toolCall" ? [{ id: p.id, result: results.has(p.id), subagent: results.get(p.id) ?? null }] : []
        )
      : []
  )
}

/**
 * The children a run's conversation started (§4, §7): its own run's by a call it holds, and an
 * earlier run's only where the call it holds is that same call: still without a result (carried
 * on now), or with a result naming that subagent or a run of it. A new call that reuses an
 * earlier, cut call's id (some providers number calls) never finds the earlier call's subagent.
 */
const causal = (children: ReadonlyArray<ChildRecord>, rolloutId: string, calls: ReadonlyArray<HeldCall>) => {
  const held = new Map(calls.map((c) => [c.id, c]))
  const byId = new Map(children.map((c) => [c.id, c]))
  /** Whether `from`, following its carried-on links, reaches `to`. */
  const reaches = (from: string, to: string) => {
    for (let at = byId.get(from), n = 0; at && n <= children.length; at = byId.get(at.parent_rollout_id ?? ""), n++)
      if (at.id === to) return true
    return false
  }
  return children.filter((c) => {
    const call = held.get(c.spawned_by_call_id)
    if (!call) return false
    if (c.spawned_by_rollout_id === rolloutId || !call.result) return true
    return call.subagent !== null && (reaches(call.subagent, c.id) || reaches(c.id, call.subagent))
  })
}

/**
 * A reply's subagents so far (§6.2: the counts are per reply, not per run): those its run
 * started, and those of the runs it was resumed from (resumeLineage) whose calls it kept, so a
 * Stop and Resume never starts the count or the shared budget again, while a call cut by carrying
 * on from an earlier step takes its subagents with it. `resumed`: a run carrying one of them on
 * with the reply (§8), the same subagent, counted once but spending its own.
 */
export const replySubagents = (sql: SqlClient.SqlClient, rolloutId: string) =>
  Effect.gen(function* () {
    const runs = (yield* resumeLineage(sql, rolloutId)).map((r) => r.id)
    const rows = yield* sql<{
      id: string
      spawned_by_rollout_id: string
      spawned_by_call_id: string
      parent_rollout_id: string | null
      resumed: number
    }>`
      SELECT r.id, r.spawned_by_rollout_id, r.spawned_by_call_id, r.parent_rollout_id,
        EXISTS (SELECT 1 FROM rollouts s WHERE s.id = r.parent_rollout_id
          AND s.spawned_by_call_id = r.spawned_by_call_id) AS resumed
      FROM rollouts r WHERE r.spawned_by_rollout_id IN (SELECT value FROM json_each(${JSON.stringify(runs)}))`
    if (runs.length <= 1 || rows.every((r) => r.spawned_by_rollout_id === rolloutId)) return rows
    const [own] = yield* sql<{ transcript: string | null }>`
      SELECT transcript_json AS transcript FROM rollout_payloads WHERE rollout_id = ${rolloutId}`
    return yield* retainedChildRuns(sql, runs, rows, parse<ReadonlyArray<AgentMessage>>(own?.transcript ?? null, []))
  })

/** What these subagents' requests cost together; `finished`: only requests that have ended. */
export const spendOf = (sql: SqlClient.SqlClient, ids: ReadonlyArray<string>, finished = false) =>
  ids.length === 0
    ? Effect.succeed({ cost: 0, unpriced: 0 })
    : sql<{ cost: number | null; unpriced: number | null }>`
        SELECT sum(q.cost) AS cost, sum(CASE WHEN q.cost IS NULL THEN 1 ELSE 0 END) AS unpriced
        FROM llm_requests q WHERE q.rollout_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
          ${finished ? sql`AND q.status <> 'running'` : sql``}`.pipe(
        Effect.map(([row]) => ({ cost: row?.cost ?? 0, unpriced: row?.unpriced ?? 0 }))
      )

interface ChildRecord {
  readonly id: string
  readonly handle: string
  readonly status: string
  readonly spawned_by_rollout_id: string
  readonly spawned_by_call_id: string
  readonly parent_rollout_id: string | null
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
  readonly copy_outcome: string | null
}

/** A run chain's children, newest first; `calls` narrows them to those calls. */
const childrenOf = (sql: SqlClient.SqlClient, chain: ReadonlyArray<string>, calls?: ReadonlyArray<string>) =>
  sql<ChildRecord>`
    SELECT r.id, r.agent_handle AS handle, r.status, r.spawned_by_rollout_id, r.spawned_by_call_id,
      r.parent_rollout_id, r.step_count,
      r.created_at, r.completed_at, r.error,
      p.context_snapshot_json AS snapshot, p.transcript_json AS transcript,
      (SELECT count(*) FROM llm_requests q WHERE q.rollout_id = r.id) AS requests,
      (SELECT sum(q.cost) FROM llm_requests q WHERE q.rollout_id = r.id) AS cost,
      (SELECT min(q.cost_currency) FROM llm_requests q WHERE q.rollout_id = r.id) AS currency,
      (SELECT count(*) FROM llm_requests q WHERE q.rollout_id = r.id AND q.cost IS NULL) AS unpriced,
      (SELECT t.result_json FROM rollout_receipts t WHERE t.rollout_id = r.id AND t.tool_call_id = ${COPY_CALL}) AS copy_outcome
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
const statusOf = (status: string, steps: ReadonlyArray<ChildStep>, error: string | null): SubagentStatus =>
  status === "stopped" && error === LIMIT_STOP
    ? "limit"
    : status === "running" || status === "created"
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
  // A fork's own turns only: before its task is its parent's conversation (spec/SUBAGENTS.md §2.3).
  for (let i = messages.length - 1; i >= forkStart(messages); i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const text = m.content.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text] : [])).join("")
    if (text) return text
  }
  return null
}

/**
 * A child as its row shows it, from its rollout, snapshot, transcript and ledger rows. `earlier`:
 * the runs of the same call it was resumed from (§8), whose time and cost it adds to its own.
 */
const rowOf = (r: ChildRecord, earlier: ReadonlyArray<ChildRecord> = []): SubagentRow => {
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
  const outcome = parse<string | null>(r.copy_outcome, null)
  const kept = outcome === null ? undefined : parse<{ readonly kept?: unknown }>(outcome, {}).kept
  // Its latest progress line (`report_progress`, §4), from its own steps.
  const progress = steps.findLast((s) => s.kind === "tool" && s.tool === PROGRESS)
  const line =
    progress?.kind === "tool" && typeof (progress.args as { text?: unknown } | undefined)?.text === "string"
      ? (progress.args as { text: string }).text.trim() || undefined
      : undefined
  return {
    rolloutId: r.id,
    handle: r.handle,
    type: sub?.type ?? "",
    typeLabel: sub?.typeLabel ?? "Subagent",
    ...(sub?.typeExplanation ? { typeExplanation: sub.typeExplanation } : {}),
    ...(sub?.name ? { name: sub.name } : {}),
    task: sub?.task ?? "",
    alias: sub?.alias ?? "same",
    model: sub?.model ?? "",
    ...(sub?.effort ? { effort: sub.effort } : {}),
    status: statusOf(r.status, steps, r.error),
    steps,
    count: r.step_count,
    ms:
      r.completed_at === null
        ? null
        : [r, ...earlier].reduce((ms, c) => ms + Math.max(0, (c.completed_at ?? c.created_at) - c.created_at), 0),
    cost: running ? null : costOf([r, ...earlier]),
    ...(earlier.length > 0 ? { resumed: true } : {}),
    ...(line ? { progress: line } : {}),
    ...(sub?.background ? { background: true } : {}),
    ...(sub?.continued ? { continued: true } : {}),
    ...(sub?.context === "fork" ? { forked: true } : {}),
    ...(sub?.workspace?.copy
      ? {
          copy: {
            path: sub.workspace.copy.path,
            from: sub.workspace.copy.from,
            ...(sub.workspace.copy.branch ? { branch: sub.workspace.copy.branch } : {}),
            ...(typeof kept === "boolean" ? { kept } : {})
          }
        }
      : sub?.workspace
        ? { folder: sub.workspace.start }
        : {})
  }
}

/** The subagent's own tool for a one-line status (spec/SUBAGENTS.md §4). */
export const PROGRESS = "report_progress"

/** What the runs' requests cost together, when every one was priced in one currency. */
const costOf = (runs: ReadonlyArray<ChildRecord>) => {
  const priced = runs.filter((c) => c.requests > 0)
  const currency = priced[0]?.currency ?? null
  if (priced.length === 0 || currency === null) return null
  if (priced.some((c) => c.unpriced > 0 || c.cost === null || c.currency !== currency)) return null
  return { amount: priced.reduce((sum, c) => sum + c.cost!, 0), currency }
}

/**
 * Each call's subagent as it stands, newest first by call: the run that answers it now, then the
 * runs it was resumed from (its `parent_rollout_id` links among the same call's children).
 */
const byCall = (children: ReadonlyArray<ChildRecord>) => {
  const calls = new Map<string, Array<ChildRecord>>()
  for (const child of children) {
    const runs = calls.get(child.spawned_by_call_id)
    if (runs) runs.push(child)
    else calls.set(child.spawned_by_call_id, [child])
  }
  return new Map([...calls].map(([call, runs]) => [call, resumedChain(runs)]))
}

/** The newest run and the runs it carries on from, newest first. */
const resumedChain = (runs: ReadonlyArray<ChildRecord>): ReadonlyArray<ChildRecord> => {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const chain: Array<ChildRecord> = []
  for (let run = runs[0]; run && chain.length < runs.length; run = byId.get(run.parent_rollout_id ?? ""))
    chain.push(run)
  return chain
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

/** The runs of a child's call it was resumed from, newest first (§8). */
const earlierRuns = (sql: SqlClient.SqlClient, userId: UserId, versionId: VersionId, child: ChildRecord) =>
  Effect.gen(function* () {
    const chain = yield* chainOf(sql, yield* versionRollout(sql, userId, versionId))
    const runs = (yield* childrenOf(sql, chain, [child.spawned_by_call_id])).filter(
      (c) => c.created_at <= child.created_at
    )
    return resumedChain([child, ...runs.filter((c) => c.id !== child.id)]).slice(1)
  })

/**
 * A run's tool steps with the subagents their calls started (spec/SUBAGENTS.md §7):
 * for the stored steps, read in the same transaction as them.
 */
export const withSubagents = <S extends { readonly kind: string }>(
  sql: SqlClient.SqlClient,
  rolloutId: string,
  steps: ReadonlyArray<S>,
  messages: ReadonlyArray<AgentMessage>
) =>
  Effect.gen(function* () {
    // Any tool's call may have started one (`agent`, `message_agent`, the story helper, a plugin's).
    const calls = steps.flatMap((s) => (s.kind === "tool" ? [(s as unknown as { id: string }).id] : []))
    if (calls.length === 0) return steps
    const children = byCall(
      causal(yield* childrenOf(sql, yield* chainOf(sql, rolloutId), calls), rolloutId, heldCalls(messages))
    )
    return steps.map((s) => {
      const runs = s.kind === "tool" ? children.get((s as unknown as { id: string }).id) : undefined
      return runs ? { ...s, subagent: rowOf(runs[0]!, runs.slice(1)) } : s
    })
  })

export const makeSubagentReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SubagentStartRoom: ({ userId, parentRolloutId, perRun, runCost }) =>
      Effect.gen(function* () {
        const [parent] = yield* sql<{ readonly status: string; readonly spawned_by_rollout_id: string | null }>`
          SELECT r.status, r.spawned_by_rollout_id FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${parentRolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!parent) return yield* new NotFound({ entity: "rollout", id: parentRolloutId })
        return yield* startRefusal(sql, parent, parentRolloutId, perRun, runCost)
      }).pipe(query("SubagentStartRoom")),
    OrphanedSubagentCopies: ({ before }) =>
      Effect.gen(function* () {
        // Each copy's newest run: an earlier run's outcome was settled by the run carrying it on.
        const rows = yield* sql<{
          user_id: string
          rollout_id: string
          copy: string
          created_at: number
          outcome: number
        }>`
          WITH runs AS (
            SELECT c.owner_user_id AS user_id, r.id AS rollout_id, r.created_at,
              json_extract(p.context_snapshot_json, '$.subagent.workspace.copy') AS copy,
              json_extract(p.context_snapshot_json, '$.subagent.workspace.copy.path') AS path,
              EXISTS (SELECT 1 FROM rollout_receipts t WHERE t.rollout_id = r.id AND t.tool_call_id = ${COPY_CALL}) AS outcome
            FROM rollouts r JOIN chats c ON c.id = r.chat_id JOIN rollout_payloads p ON p.rollout_id = r.id
            WHERE r.spawned_by_rollout_id IS NOT NULL
              AND json_extract(p.context_snapshot_json, '$.subagent.workspace.copy.path') IS NOT NULL
          ),
          newest AS (
            SELECT *, row_number() OVER (PARTITION BY user_id, path ORDER BY created_at DESC, rollout_id DESC) AS n FROM runs
          )
          SELECT user_id, rollout_id, copy, created_at, outcome FROM newest WHERE n = 1`
        return rows
          .filter((r) => !r.outcome && r.created_at < before)
          .map((r) => ({ userId: r.user_id as UserId, rolloutId: r.rollout_id, copy: r.copy }))
      }).pipe(query("OrphanedSubagentCopies")),
    FindSubagent: ({ userId, rolloutId, toolCallId }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ id: string }>`SELECT r.id FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const [child, ...earlier] = resumedChain(yield* childrenOf(sql, yield* chainOf(sql, rolloutId), [toolCallId]))
        if (!child) return null
        return {
          rolloutId: child.id,
          handle: child.handle,
          status: child.status,
          partial: lastText(parse<ReadonlyArray<AgentMessage>>(child.transcript, [])),
          row: rowOf(child, earlier),
          transcript: child.transcript,
          snapshot: child.snapshot,
          spawnedBy: child.spawned_by_rollout_id
        }
      }).pipe(query("FindSubagent")),

    // A subagent the parent names (`message_agent`, §4): by handle, else by the name it was given,
    // among those started on its run chain by calls its transcript holds, so one in a version that
    // was swiped away or on another branch is never found. The newest run of it answers.
    FindSubagentByHandle: ({ userId, rolloutId, handle, calls }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql<{ id: string }>`SELECT r.id FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "rollout", id: rolloutId })
        const children = causal(
          yield* childrenOf(
            sql,
            yield* chainOf(sql, rolloutId),
            calls.map((c) => c.id)
          ),
          rolloutId,
          calls
        )
        const wanted = handle.trim().toLowerCase()
        const named = (c: ChildRecord) =>
          parse<{ readonly subagent?: SubagentSnapshot }>(c.snapshot, {}).subagent?.name?.trim().toLowerCase()
        const child =
          children.find((c) => c.handle.toLowerCase() === wanted) ?? children.find((c) => named(c) === wanted)
        if (!child) return null
        return {
          rolloutId: child.id,
          handle: child.handle,
          status: child.status,
          partial: lastText(parse<ReadonlyArray<AgentMessage>>(child.transcript, [])),
          row: rowOf(child),
          transcript: child.transcript,
          snapshot: child.snapshot,
          spawnedBy: child.spawned_by_rollout_id
        }
      }).pipe(query("FindSubagentByHandle")),

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
          row: rowOf(child, yield* earlierRuns(sql, userId, versionId, child)),
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
          // A fork's from its task on: before it is the reply's own conversation, shown with the reply.
          entries: transcriptEntries(
            messages.slice(forkStart(messages)),
            tools.length,
            snapshot.agent?.turnCap ?? Number.MAX_SAFE_INTEGER
          ),
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

/**
 * Why the run can't start another subagent now (§6.2), or null: it's a subagent itself, it has
 * ended, it has started as many as it may (per reply, across its Stops and Resumes; a child
 * resumed with it, §8, is the same subagent), or its subagents have spent what they may.
 */
const startRefusal = (
  sql: SqlClient.SqlClient,
  parent: { readonly status: string; readonly spawned_by_rollout_id: string | null },
  parentRolloutId: string,
  perRun: number | undefined,
  runCost: number | undefined
) =>
  Effect.gen(function* () {
    if (parent.spawned_by_rollout_id !== null) return "nested" as const
    if (parent.status !== "running") return "not_running" as const
    const reply = yield* replySubagents(sql, parentRolloutId)
    if (reply.filter((r) => !r.resumed).length >= (perRun ?? SUBAGENTS_PER_RUN)) return "limit" as const
    if (
      runCost !== undefined &&
      (yield* spendOf(
        sql,
        reply.map((r) => r.id)
      )).cost >= runCost
    )
      return "spent" as const
    return null
  })

export const makeSubagentWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    StartSubagent: ({
      userId,
      parentRolloutId,
      callId,
      rolloutId,
      type,
      connectionId,
      modelId,
      snapshot,
      perRun,
      runCost
    }) =>
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
        const refused = yield* startRefusal(sql, parent, parentRolloutId, perRun, runCost)
        if (refused !== null) return { refused }
        // Numbered across the run chain, so a handle names one child wherever the run carried on.
        const chain = yield* chainOf(sql, parentRolloutId)
        const [same] = yield* sql<{ n: number }>`
          SELECT count(DISTINCT agent_handle) AS n FROM rollouts
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
