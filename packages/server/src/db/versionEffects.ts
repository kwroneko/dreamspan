// Attribute changes to the calls a version kept, including results replayed on Resume.
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { callsFrom } from "../agent/steps.ts"
import { recoveredOperationText } from "./operationReceipts.ts"
import { childEffects, newestFirst, resumeLineage } from "./subagentEffects.ts"
import { toRolloutEffect } from "./workshopEffects.ts"

export const attributedEffects = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  rolloutId: string,
  transcript: ReadonlyArray<AgentMessage>,
  calls: ReadonlyMap<string, string | null>,
  creationsOnly = false
) {
  if (calls.size === 0) return []
  const runs = yield* resumeLineage(sql, rolloutId)
  const rows = yield* sql<Parameters<typeof toRolloutEffect>[0]>`SELECT e.* FROM rollout_effects e
      WHERE e.rollout_id IN ${sql.in(runs.map((r) => r.id))}
      ${creationsOnly ? sql`AND e.kind = 'library.create' AND e.target_kind = 'entity' AND e.undone_at IS NULL` : sql``}
      ORDER BY e.created_at DESC, e.rollout_id DESC, e.tool_call_id DESC, e.seq DESC`
  const earlier = [...new Set(rows.map((r) => r.rollout_id))].filter((id) => id !== rolloutId)
  const results = new Map<string, Map<string, string | null>>()
  const receipts = new Map<string, Map<string, string>>()
  // A crash may leave a committed effect and receipt before its transcript result.
  // Only a matching receipt carried into this run can prove that missing result;
  // an unrelated call reusing the same id must not inherit the effect.
  if (earlier.length > 0)
    for (const receipt of yield* sql<{ rollout_id: string; tool_call_id: string; result_json: string }>`
        SELECT rollout_id, tool_call_id, result_json FROM rollout_receipts
        WHERE rollout_id IN ${sql.in(runs.map((run) => run.id))}`) {
      let calls = receipts.get(receipt.rollout_id)
      if (!calls) receipts.set(receipt.rollout_id, (calls = new Map()))
      calls.set(receipt.tool_call_id, receipt.result_json)
    }
  if (earlier.length > 0)
    for (const run of yield* sql<{ rollout_id: string; transcript: string | null }>`SELECT rollout_id,
          transcript_json AS transcript FROM rollout_payloads WHERE rollout_id IN ${sql.in(earlier)}`)
      results.set(
        run.rollout_id,
        run.transcript === null ? new Map() : callsFrom(JSON.parse(run.transcript) as ReadonlyArray<AgentMessage>)
      )
  // The changes of the subagents its kept `agent` calls started (spec/SUBAGENTS.md §8): a
  // call cut by carrying on from an earlier step leaves its subagents' with the old version.
  const children = yield* childEffects(
    sql,
    runs.map((r) => r.id),
    {
      kept: { calls: new Set(calls.keys()), transcript },
      undone: !creationsOnly,
      ...(creationsOnly ? { kind: "library.create" } : {})
    }
  )
  const own = rows
    .filter((row) => {
      if (!calls.has(row.tool_call_id)) return false
      if (row.rollout_id === rolloutId) return true
      const there = results.get(row.rollout_id)?.get(row.tool_call_id)
      if (there !== undefined && there !== null && there === calls.get(row.tool_call_id)) return true
      const kept = receipts.get(rolloutId)?.get(row.tool_call_id)
      return (
        kept !== undefined &&
        kept === receipts.get(row.rollout_id)?.get(row.tool_call_id) &&
        recoveredOperationText(JSON.parse(kept) as string) === calls.get(row.tool_call_id)
      )
    })
    .map(toRolloutEffect)
  return children.length === 0 ? own : [...own, ...children].sort(newestFirst)
})
