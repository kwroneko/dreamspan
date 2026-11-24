// What subagents changed (spec/SUBAGENTS.md §8): a child's library, setup and file changes are
// `rollout_effects` rows of its own rollout, listed with the reply whose `agent` call started it,
// kept or dropped with that call, and named by its handle in Changes and the regenerate warning.
import type { RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { toRolloutEffect } from "./workshopEffects.ts"

type Sql = SqlClient.SqlClient

/** How many runs back a resume's approval or effects are looked for. */
const RESUME_DEPTH = 64

/**
 * The run and the runs it was resumed from, nearest first: through resumed versions' sources,
 * not `parent_rollout_id`, which a run carrying on the previous turn's also sets (bounded).
 */
export const resumeLineage = (sql: Sql, rolloutId: string) =>
  sql<{ id: string; depth: number }>`WITH RECURSIVE up(id, depth) AS (
      SELECT ${rolloutId}, 0
      UNION SELECT src.rollout_id, up.depth + 1 FROM up
        JOIN versions v ON v.rollout_id = up.id AND v.origin = 'resumed' AND v.source_version_id IS NOT NULL
        JOIN versions src ON src.id = v.source_version_id
        WHERE src.rollout_id IS NOT NULL AND up.depth < ${RESUME_DEPTH}
    ) SELECT id, min(depth) AS depth FROM up GROUP BY id ORDER BY depth`

interface ChildRun {
  readonly id: string
  readonly spawned_by_rollout_id: string
  readonly spawned_by_call_id: string
  readonly parent_rollout_id: string | null
}

interface Spawn extends ChildRun {
  readonly agent_handle: string
}

const label = (spawn: Spawn) => ({
  handle: spawn.agent_handle,
  rolloutId: spawn.spawned_by_rollout_id,
  callId: spawn.spawned_by_call_id
})

/** The effects, each a subagent made marked with its handle and the call that started it. */
export const markSubagentEffects = (sql: Sql, effects: ReadonlyArray<RolloutEffect>) =>
  Effect.gen(function* () {
    const ids = [...new Set(effects.map((e) => e.rolloutId))]
    if (ids.length === 0) return effects
    const spawns = new Map(
      (yield* sql<Spawn>`SELECT id, spawned_by_rollout_id, spawned_by_call_id, parent_rollout_id, agent_handle FROM rollouts
        WHERE id IN ${sql.in(ids)} AND spawned_by_rollout_id IS NOT NULL`).map((s) => [s.id, s])
    )
    if (spawns.size === 0) return effects
    return effects.map((e) => {
      const spawn = spawns.get(e.rolloutId)
      return spawn ? { ...e, subagent: label(spawn) } : e
    })
  })

const indexedCalls = (transcript: ReadonlyArray<AgentMessage>, wanted: ReadonlySet<string>) => {
  const calls = new Map<
    string,
    {
      readonly index: number
      readonly turn: number
      readonly name: string
      readonly args: unknown
      result?: Extract<AgentMessage, { role: "toolResult" }>
    }
  >()
  let indexOfTurn = -1
  for (const [index, message] of transcript.entries()) {
    if (message.role === "assistant") {
      indexOfTurn = index
      for (const part of message.content)
        if (part.type === "toolCall" && wanted.has(part.id))
          calls.set(part.id, { index, turn: message.timestamp, name: part.name, args: part.arguments })
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId)
      if (call?.index === indexOfTurn) call.result = message
    }
  }
  return calls
}

/** Which children this reply kept, following only each selected child's own resume ancestry. */
export const retainedChildRuns = <R extends ChildRun>(
  sql: Sql,
  runs: ReadonlyArray<string>,
  children: ReadonlyArray<R>,
  transcript: ReadonlyArray<AgentMessage>
) =>
  Effect.gen(function* () {
    const [current] = runs
    const nearness = new Map(runs.map((id, index) => [id, index]))
    const byCall = new Map<string, Array<R>>()
    for (const child of children) {
      const list = byCall.get(child.spawned_by_call_id) ?? []
      list.push(child)
      byCall.set(child.spawned_by_call_id, list)
    }
    const calls = indexedCalls(transcript, new Set(byCall.keys()))
    const kept: Array<R> = []
    const ambiguous = new Map<string, Array<R>>()
    const keep = (selected: R, candidates: ReadonlyArray<R>) => {
      const byId = new Map(candidates.map((r) => [r.id, r]))
      for (let child: R | undefined = selected; child; child = byId.get(child.parent_rollout_id ?? "")) {
        kept.push(child)
        byId.delete(child.id)
      }
    }
    for (const [id, candidates] of byCall) {
      const own = candidates.find((r) => r.spawned_by_rollout_id === current)
      const call = calls.get(id)
      const named = (call?.result?.details as { subagent?: { rolloutId?: unknown } } | null | undefined)?.subagent
        ?.rolloutId
      const selected = own ?? candidates.find((r) => r.id === named)
      if (selected) keep(selected, candidates)
      else if (call && typeof named !== "string") ambiguous.set(id, candidates)
    }
    if (ambiguous.size === 0) return kept

    const earlier = [...new Set([...ambiguous.values()].flatMap((rows) => rows.map((r) => r.spawned_by_rollout_id)))]
    const wanted = new Set(ambiguous.keys())
    const evidence = new Map(
      (yield* sql<{ rollout_id: string; transcript_json: string | null }>`SELECT rollout_id, transcript_json
        FROM rollout_payloads WHERE rollout_id IN ${sql.in(earlier)}`).map((row) => [
        row.rollout_id,
        indexedCalls(JSON.parse(row.transcript_json ?? "[]") as ReadonlyArray<AgentMessage>, wanted)
      ])
    )
    const receipts = new Map<string, string>()
    for (const row of yield* sql<{ rollout_id: string; tool_call_id: string; result_json: string; is_error: number }>`
      SELECT rollout_id, tool_call_id, result_json, is_error FROM rollout_receipts
      WHERE rollout_id IN ${sql.in([current!, ...earlier])} AND tool_call_id IN ${sql.in([...wanted])}`)
      receipts.set(`${row.rollout_id}\0${row.tool_call_id}`, `${row.is_error}:${row.result_json}`)
    for (const [id, candidates] of ambiguous) {
      const call = calls.get(id)!
      const receipt = receipts.get(`${current}\0${id}`)
      const selected = candidates
        .sort((a, b) => nearness.get(a.spawned_by_rollout_id)! - nearness.get(b.spawned_by_rollout_id)!)
        .find((child) => {
          const run = child.spawned_by_rollout_id
          const old = evidence.get(run)?.get(id)
          // The kept turn may still lack a result, or it may replay the receipt of the same call.
          if (!old || old.turn !== call.turn || old.name !== call.name || !isDeepStrictEqual(old.args, call.args))
            return false
          if (receipt !== undefined && receipt === receipts.get(`${run}\0${id}`)) return true
          return (
            call.result === undefined &&
            (old.result === undefined || (old.result.details as { interrupted?: boolean } | null)?.interrupted === true)
          )
        })
      if (selected) keep(selected, candidates)
    }
    return kept
  })

/** The effects of the subagents these runs' calls started, newest first. */
export const childEffects = (
  sql: Sql,
  runs: ReadonlyArray<string>,
  options: {
    readonly kept?: { readonly calls: ReadonlySet<string>; readonly transcript: ReadonlyArray<AgentMessage> }
    readonly undone: boolean
    readonly kind?: RolloutEffect["kind"]
  }
) =>
  Effect.gen(function* () {
    if (runs.length === 0) return []
    const found = (yield* sql<Spawn>`SELECT id,
        spawned_by_rollout_id, spawned_by_call_id, agent_handle, parent_rollout_id
      FROM rollouts WHERE spawned_by_rollout_id IN ${sql.in([...runs])}`).filter(
      (s) => options.kept === undefined || options.kept.calls.has(s.spawned_by_call_id)
    )
    const spawns =
      options.kept === undefined ? found : yield* retainedChildRuns(sql, runs, found, options.kept.transcript)
    if (spawns.length === 0) return []
    const byId = new Map(spawns.map((s) => [s.id, s]))
    const rows = yield* sql<Parameters<typeof toRolloutEffect>[0]>`SELECT * FROM rollout_effects
      WHERE rollout_id IN ${sql.in([...byId.keys()])} ${options.undone ? sql`` : sql`AND undone_at IS NULL`}
      ${options.kind === undefined ? sql`` : sql`AND kind = ${options.kind}`}
      ORDER BY created_at DESC, rollout_id DESC, tool_call_id DESC, seq DESC`
    return rows.map((row): RolloutEffect => ({ ...toRolloutEffect(row), subagent: label(byId.get(row.rollout_id)!) }))
  })

/** Newest first, as every effect list is. */
export const newestFirst = (a: RolloutEffect, b: RolloutEffect) =>
  b.createdAt - a.createdAt ||
  (a.rolloutId < b.rolloutId ? 1 : a.rolloutId > b.rolloutId ? -1 : 0) ||
  (a.toolCallId < b.toolCallId ? 1 : a.toolCallId > b.toolCallId ? -1 : 0) ||
  b.seq - a.seq
