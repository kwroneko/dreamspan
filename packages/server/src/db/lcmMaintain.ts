import type { UserId } from "@rp/shared/domain.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { layerText } from "../assembler/lcm.ts"
import { type Candidate, planMaintenance } from "../lcm/maintenance.ts"
import { type PlannedJob } from "./lcmJobs.ts"
import { lineageValidator } from "./lcmLayer.ts"
import { type LcmSlot, lcmPath, slotInput } from "./lcmPath.ts"
import { readSummary } from "./lcmReads.ts"

/** How many jobs one plan asks the writer for; the rest follow in later plans, so a write stays short. */
export const MAX_JOBS_PER_PLAN = 4
const DEFAULT_FANOUT = 5
const DEFAULT_CONDENSE_TARGET = 800

/**
 * What a reply (or a finished job) should start for the summaries on a path (spec/LCM.md §2.2):
 * condensations, stale level-1 summaries to write again, and the stale ones left to the user.
 * Planning never changes a row.
 */
export const maintain = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  chatId: string,
  leaf: string,
  layer: { readonly summaries: ReadonlyArray<Summary> },
  options: {
    readonly reason: "reply" | "completion"
    readonly fanout?: number | undefined
    readonly condenseTarget?: number | undefined
    readonly leafTarget: number
    readonly clipTokens: number
    readonly budget: { readonly target: number; readonly maximum: number }
  }
) =>
  Effect.gen(function* () {
    const fanout = options.fanout ?? DEFAULT_FANOUT,
      condenseTarget = options.condenseTarget ?? DEFAULT_CONDENSE_TARGET
    const valid = lineageValidator(sql, userId)
    const memo = new Map<string, Summary>()
    const onPath = sql`WITH RECURSIVE path(id) AS (
      SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
    )`
    const liveBatches = new Set(
      (yield* sql<{ batch_id: string }>`SELECT DISTINCT batch_id FROM summarization_jobs
        WHERE chat_id = ${chatId} AND status IN ('pending', 'processing') AND batch_id IS NOT NULL`).map(
        (r) => r.batch_id
      )
    )
    const rows = yield* sql<{ id: string; status: string }>`${onPath}
      SELECT s.id, s.status FROM path JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
      WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status IN ('complete', 'truncated', 'superseded', 'failed')`
    const candidates: Array<Candidate> = []
    const held: Array<{ level: number; from: number; to: number }> = []
    for (const row of rows) {
      if (!(yield* valid(row.id))) continue
      const summary = yield* readSummary(sql, userId, row.id, undefined, memo)
      if (summary.to - summary.from + 1 !== summary.slotCount) continue
      // A failed summary whose inputs are unchanged holds its range until Retry.
      if (row.status === "failed") {
        if (summary.fresh) held.push({ level: summary.level, from: summary.from, to: summary.to })
        continue
      }
      candidates.push({ ...summary, batchLive: summary.batchId !== null && liveBatches.has(summary.batchId) })
    }
    const jobs = yield* sql<{ level: number; from: number; to: number; input_child_ids: string | null }>`${onPath}
      SELECT j.level, a.depth + 1 AS "from", b.depth + 1 AS "to", j.input_child_ids
      FROM path JOIN summarization_jobs j ON j.last_slot_id = path.id
        JOIN slots a ON a.id = j.first_slot_id JOIN slots b ON b.id = j.last_slot_id
      WHERE j.chat_id = ${chatId} AND j.status IN ('pending', 'processing')`
    // The chains of stale level-1 summaries: whether anything in them can still be summarized, and what to send.
    const chains = new Map<string, ReadonlyArray<LcmSlot>>()
    const chainOf = (s: Summary) => lcmPath(sql, userId, chatId, s.lastSlotId, s.firstSlotId)
    for (const s of candidates)
      if (s.level === 1 && !s.fresh && s.status !== "superseded") chains.set(s.id, yield* chainOf(s))
    const [last] = yield* sql<{ eager: number }>`
      SELECT eager FROM summarization_jobs WHERE chat_id = ${chatId} AND status IN ('complete', 'failed')
      ORDER BY updated_at DESC, id DESC LIMIT 1`
    const plan = planMaintenance({
      summaries: candidates,
      layer: layer.summaries,
      liveJobs: jobs.map((j) => ({
        level: j.level,
        from: j.from,
        to: j.to,
        children: j.input_child_ids ? (JSON.parse(j.input_child_ids) as Array<string>) : []
      })),
      held,
      hasContent: (s) => chains.get(s.id)?.some((slot) => slot.versionId !== null) ?? true,
      reason: options.reason,
      settings: {
        fanout,
        condenseTarget,
        eagerMinChildren: 2,
        absorbMaxChildren: fanout * 2,
        layerCost: layer.summaries.length ? Math.ceil(layerText(layer.summaries, false).length / 4) + 3 : 0,
        layerTarget: options.budget.target,
        layerMax: options.budget.maximum,
        lastFinishedEager: last?.eager === 1
      }
    })
    const refresh = plan.resummarize.flatMap((id) => {
      const chain = chains.get(id)
      // A slot still being written, or a merge, can't be summarized; the next pass will see it.
      if (!chain?.length || chain.some((s) => s.generating || s.merged)) return []
      return [
        { inputs: chain.map(slotInput), target: options.leafTarget, clipTokens: options.clipTokens, refresh: true }
      ]
    })
    const condensations: Array<PlannedJob> = plan.condensations.map((c) => ({
      level: c.level,
      children: c.children as PlannedJob["children"],
      target: condenseTarget,
      eager: c.eager,
      ...(c.absorbedParentId ? { absorbedParentId: c.absorbedParentId as never } : {})
    }))
    return {
      condensations: condensations.slice(0, MAX_JOBS_PER_PLAN),
      refresh: refresh.slice(0, MAX_JOBS_PER_PLAN),
      flagged: plan.flagged as Array<Summary["id"]>
    }
  })
