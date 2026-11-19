// What subagents changed (spec/SUBAGENTS.md §8): a child's library, setup and file changes are
// `rollout_effects` rows of its own rollout, listed with the reply whose `agent` call started it,
// kept or dropped with that call, and named by its handle in Changes and the regenerate warning.
import type { RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { toRolloutEffect } from "./workshopEffects.ts"

type Sql = SqlClient.SqlClient

interface Spawn {
  readonly id: string
  readonly spawned_by_rollout_id: string
  readonly spawned_by_call_id: string
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
      (yield* sql<Spawn>`SELECT id, spawned_by_rollout_id, spawned_by_call_id, agent_handle FROM rollouts
        WHERE id IN ${sql.in(ids)} AND spawned_by_rollout_id IS NOT NULL`).map((s) => [s.id, s])
    )
    if (spawns.size === 0) return effects
    return effects.map((e) => {
      const spawn = spawns.get(e.rolloutId)
      return spawn ? { ...e, subagent: label(spawn) } : e
    })
  })

/**
 * The effects of the subagents these runs' calls started (resumed ones included), newest first;
 * `runs` nearest first (a run, then the runs it was resumed from); `calls` narrows them to those calls. `undone`: with the undone ones too.
 */
export const childEffects = (
  sql: Sql,
  runs: ReadonlyArray<string>,
  options: { readonly calls?: ReadonlySet<string>; readonly undone: boolean }
) =>
  Effect.gen(function* () {
    if (runs.length === 0) return []
    const found = (yield* sql<Spawn & { parent_rollout_id: string | null; created_at: number }>`SELECT id,
        spawned_by_rollout_id, spawned_by_call_id, agent_handle, parent_rollout_id, created_at
      FROM rollouts WHERE spawned_by_rollout_id IN ${sql.in([...runs])}`).filter(
      (s) => options.calls === undefined || options.calls.has(s.spawned_by_call_id)
    )
    // Per call, the subagent of the nearest run and the runs it was resumed from: a call another
    // run made under the same id (some providers number their calls) started a different one.
    const nearness = new Map(runs.map((id, at) => [id, at]))
    const byCall = new Map<string, Array<(typeof found)[number]>>()
    for (const s of found) byCall.set(s.spawned_by_call_id, [...(byCall.get(s.spawned_by_call_id) ?? []), s])
    const spawns = [...byCall.values()].flatMap((all) => {
      const sorted = [...all].sort(
        (a, b) =>
          nearness.get(a.spawned_by_rollout_id)! - nearness.get(b.spawned_by_rollout_id)! || b.created_at - a.created_at
      )
      const byId = new Map(sorted.map((s) => [s.id, s]))
      const chain: Array<(typeof found)[number]> = []
      for (let at = sorted[0]; at && chain.length < sorted.length; at = byId.get(at.parent_rollout_id ?? ""))
        chain.push(at)
      return chain
    })
    if (spawns.length === 0) return []
    const byId = new Map(spawns.map((s) => [s.id, s]))
    const rows = yield* sql<Parameters<typeof toRolloutEffect>[0]>`SELECT * FROM rollout_effects
      WHERE rollout_id IN ${sql.in([...byId.keys()])} ${options.undone ? sql`` : sql`AND undone_at IS NULL`}
      ORDER BY created_at DESC, rollout_id DESC, tool_call_id DESC, seq DESC`
    return rows.map((row): RolloutEffect => ({ ...toRolloutEffect(row), subagent: label(byId.get(row.rollout_id)!) }))
  })

/** Newest first, as every effect list is. */
export const newestFirst = (a: RolloutEffect, b: RolloutEffect) =>
  b.createdAt - a.createdAt ||
  (a.rolloutId < b.rolloutId ? 1 : a.rolloutId > b.rolloutId ? -1 : 0) ||
  (a.toolCallId < b.toolCallId ? 1 : a.toolCallId > b.toolCallId ? -1 : 0) ||
  b.seq - a.seq
