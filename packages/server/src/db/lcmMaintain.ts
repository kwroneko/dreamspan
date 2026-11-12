import type { MaintenancePlanner } from "../lcm/planning.ts"
import { rerunRequests, summaryChoices } from "./lcmFork.ts"
import { viewAt } from "./forkState.ts"
import { MAX_CHUNK_SLOTS } from "./lcmLimits.ts"
import { createHash } from "node:crypto"
import type { UserId } from "@rp/shared/domain.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { summaryBlock } from "../assembler/lcm.ts"
import { tokensOf } from "../assembler/st.ts"
import { type Candidate } from "../lcm/maintenance.ts"
import type { ModelChoice } from "@rp/shared/lcmSettings.ts"
import { type PlannedJob } from "./lcmJobs.ts"
import { lineageValidator } from "./lcmLayer.ts"
import { audienceIds } from "./lcmAudience.ts"
import { type LcmSlot, lcmPath, slotInput } from "./lcmPath.ts"
import { readSummary } from "./lcmReads.ts"
import { insertedOnPath, pathView, seamStale } from "./lcmDisplay.ts"
import { positionOf } from "./displayPath.ts"

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
    readonly planner: MaintenancePlanner
    readonly reason: "reply" | "completion"
    readonly fanout?: number | undefined
    readonly condenseTarget?: number | undefined
    readonly leafTarget: number
    readonly clipTokens: number
    readonly budget: { readonly target: number; readonly maximum: number }
    /** A view's own summaries (db/lcmAudience.ts); absent: the shared ones. */
    readonly audience?: string
  }
) =>
  Effect.gen(function* () {
    const audience = options.audience ?? null
    const identities = audience === null ? undefined : audienceIds(audience)
    const fork = yield* viewAt(sql, chatId, leaf)
    const fanout = options.fanout ?? DEFAULT_FANOUT,
      condenseTarget = options.condenseTarget ?? DEFAULT_CONDENSE_TARGET
    // In a fork that shows inserted slots, the path is its display path and ranges are positions
    // on it (spec/MESSAGE-INSERT.md §3.4), with the inserted slots a path query adds.
    const shown = yield* pathView(sql, chatId, leaf)
    const valid = lineageValidator(sql, userId, shown ?? undefined)
    const memo = new Map<string, Summary>()
    const onPath = shown
      ? sql`WITH RECURSIVE structural(id) AS (
      SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      UNION ALL SELECT s.parent_slot_id FROM slots s JOIN structural p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
    ), path(id) AS (SELECT id FROM structural UNION SELECT value FROM json_each(${insertedOnPath(shown)}))`
      : sql`WITH RECURSIVE path(id) AS (
      SELECT s.id FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${leaf} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
      UNION ALL SELECT s.parent_slot_id FROM slots s JOIN path p ON p.id = s.id WHERE s.parent_slot_id IS NOT NULL
    )`
    const liveBatches = new Set(
      (yield* sql<{ batch_id: string }>`SELECT DISTINCT batch_id FROM summarization_jobs
        WHERE chat_id = ${chatId} AND (fork_id IS NULL OR fork_id=${fork}) AND status IN ('pending', 'processing') AND batch_id IS NOT NULL
          AND audience_json IS ${audience}`).map((r) => r.batch_id)
    )
    const rows = yield* sql<{ id: string; status: string }>`${onPath}
      SELECT s.id, s.status FROM path JOIN summaries s INDEXED BY summaries_last_slot ON s.last_slot_id = path.id
      WHERE s.chat_id = ${chatId} AND s.sealed = 1 AND s.status IN ('complete', 'truncated', 'superseded', 'failed')
        AND s.audience_json IS ${audience}`
    const choices = yield* summaryChoices(sql, chatId)
    const dismissed = new Set(choices.filter((c) => c.summary_id !== c.chosen_id).map((c) => c.summary_id))
    const candidates: Array<Candidate> = []
    const held: Array<{ level: number; from: number; to: number }> = []
    const failedById = new Map<string, Summary>()
    for (const row of rows) {
      if (!(yield* valid(row.id))) continue
      const summary = yield* readSummary(sql, userId, row.id, undefined, memo, shown ?? undefined)
      if (
        shown ? summary.to - summary.from + 1 < summary.slotCount : summary.to - summary.from + 1 !== summary.slotCount
      )
        continue
      // A failed summary whose inputs are unchanged holds its range until Retry.
      if (row.status === "failed") {
        if (summary.fresh) held.push({ level: summary.level, from: summary.from, to: summary.to })
        failedById.set(summary.id, summary)
        continue
      }
      candidates.push({
        ...summary,
        protected: !dismissed.has(summary.id),
        batchLive: summary.batchId !== null && liveBatches.has(summary.batchId)
      })
    }
    // At a seam, a summary covers the inserted slots after it, stale, as the layer walk has it.
    if (shown) {
      const live = candidates.filter((s) => s.status !== "superseded")
      const extended = new Map(
        seamStale(live, shown.pieces, shown.end + 1, (s, change) => ({ ...s, ...change })).map((s) => [s.id, s])
      )
      candidates.splice(0, candidates.length, ...candidates.map((s) => extended.get(s.id) ?? s))
    }
    const jobRows = yield* sql<{
      level: number
      from: number
      to: number
      input_child_ids: string | null
      a_id: string
      a_chain: string
      a_depth: number
      b_id: string
      b_chain: string
      b_depth: number
    }>`${onPath}
      SELECT j.level, a.depth + 1 AS "from", b.depth + 1 AS "to", j.input_child_ids,
        a.id AS a_id, a.chain_id AS a_chain, a.depth AS a_depth, b.id AS b_id, b.chain_id AS b_chain, b.depth AS b_depth
      FROM path JOIN summarization_jobs j ON j.last_slot_id = path.id
        JOIN slots a ON a.id = j.first_slot_id JOIN slots b ON b.id = j.last_slot_id
      WHERE j.chat_id = ${chatId} AND (j.fork_id IS NULL OR j.fork_id=${fork}) AND j.status IN ('pending', 'processing')
        AND j.audience_json IS ${audience}`
    const jobs = jobRows.map(({ a_id, a_chain, a_depth, b_id, b_chain, b_depth, ...j }) => {
      if (!shown) return j
      const from = positionOf(shown.pieces, { id: a_id, chainId: a_chain, depth: a_depth })
      const to = positionOf(shown.pieces, { id: b_id, chainId: b_chain, depth: b_depth })
      return from === null || to === null ? j : { ...j, from: from + 1, to: to + 1 }
    })
    // Rerun requests (SetSummaryRerun) are answered by a reply's pass, and only by it: a summary the
    // user asked for is made again whatever its state; a failed one or a job that gave up is retried.
    type Ask = { readonly id: string; readonly model: typeof ModelChoice.Type | undefined }
    const forced = new Map<string, Ask>()
    const retries: Array<{ ask: Ask; level: number; first: string; last: string; children: Array<string> }> = []
    const [episode] = yield* sql<{ pins_json: string }>`SELECT pins_json FROM lcm_reply_maintenance
      WHERE chat_id = ${chatId} AND (fork_id IS NULL OR fork_id=${fork}) AND leaf_slot_id = ${leaf}`
    type Pins = {
      signatures: Record<string, string>
      asks: Array<string>
      askModels: Record<string, string | null>
      largeRequests: Record<string, Ask>
      explicit: Array<string>
    }
    const recorded = episode ? (JSON.parse(episode.pins_json) as Pins & { views?: Record<string, Pins> }) : undefined
    const previous = audience === null ? (recorded?.signatures ? recorded : undefined) : recorded?.views?.[audience]
    const askModels: Record<string, string | null> = {}
    if (options.reason === "reply" || previous) {
      const requests = yield* rerunRequests(sql, chatId)
      const asks = yield* sql<{
        id: string
        summary_id: string | null
        model_json: string | null
        job_level: number | null
        job_first: string | null
        job_last: string | null
        job_children: string | null
        job_result: string | null
      }>`SELECT r.id, r.summary_id, r.model_json, j.level AS job_level, j.first_slot_id AS job_first,
          j.last_slot_id AS job_last, j.input_child_ids AS job_children, j.result_summary_id AS job_result
        FROM summary_reruns r LEFT JOIN summarization_jobs j ON j.id = r.job_id WHERE r.chat_id = ${chatId} AND r.id IN ${sql.in(requests.map((r) => r.id))}
          AND (r.summary_id IS NOT NULL OR j.audience_json IS ${audience})`
      for (const row of asks) {
        if (
          options.reason !== "reply" &&
          (!previous?.asks.includes(row.id) || previous.askModels[row.id] !== row.model_json)
        )
          continue
        askModels[row.id] = row.model_json
        const ask: Ask = {
          id: row.id,
          ...(row.model_json ? { model: JSON.parse(row.model_json) as typeof ModelChoice.Type } : { model: undefined })
        }
        const target = row.summary_id ?? row.job_result
        const failed = target ? failedById.get(target) : undefined
        if (target && candidates.some((c) => c.id === target)) forced.set(target, ask)
        else if (failed)
          retries.push({
            ask,
            level: failed.level,
            first: failed.firstSlotId,
            last: failed.lastSlotId,
            children: failed.children.map((c) => c.summaryId)
          })
        else if (!target && row.job_first && row.job_last && row.job_level !== null) {
          const [here] = yield* sql<{ n: number }>`${onPath} SELECT count(*) AS n FROM path WHERE id = ${row.job_last}`
          if (here!.n === 1)
            retries.push({
              ask,
              level: row.job_level,
              first: row.job_first,
              last: row.job_last,
              children: row.job_children ? (JSON.parse(row.job_children) as Array<string>) : []
            })
        }
      }
    }
    // The chains of stale level-1 summaries: whether anything in them can still be summarized, and what to send.
    const chains = new Map<string, ReadonlyArray<LcmSlot>>()
    const chainOf = (s: Summary) =>
      lcmPath(sql, userId, chatId, s.lastSlotId, s.firstSlotId, Number.MAX_SAFE_INTEGER, identities)
    for (const s of candidates)
      if (s.level === 1 && s.status !== "superseded" && (!s.fresh || forced.has(s.id)))
        chains.set(s.id, yield* chainOf(s))
    const [last] = yield* sql<{ eager: number }>`
      SELECT eager FROM summarization_jobs WHERE chat_id = ${chatId} AND (fork_id IS NULL OR fork_id=${fork}) AND status IN ('complete', 'failed')
        AND audience_json IS ${audience}
      ORDER BY updated_at DESC, id DESC LIMIT 1`
    // Freeze effective message inputs and every selected child revision at the authorizing reply.
    // Completion can continue that exact episode; later edits do not inherit its permission.
    const path = candidates.length
      ? yield* lcmPath(sql, userId, chatId, leaf, undefined, Number.MAX_SAFE_INTEGER, identities)
      : []
    const byId = new Map(candidates.map((s) => [s.id as string, s]))
    const signatures: Record<string, string> = {}
    const signature = (s: Summary): string =>
      (signatures[s.id] ??= createHash("sha256")
        .update(
          JSON.stringify([
            s.revisionId,
            choices.find((c) => c.summary_id === s.id)?.chosen_id ?? null,
            s.level === 1
              ? path
                  .slice(s.from - 1, s.to)
                  // The images a slot sends are part of what a later pass may not repair unauthorized.
                  .map((slot) =>
                    slot.images.length ? [slotInput(slot), slot.images.map((i) => i.mediaId)] : slotInput(slot)
                  )
              : s.children.map((c) => {
                  const child = byId.get(c.summaryId)
                  return child ? signature(child) : c.revisionId
                })
          ])
        )
        .digest("hex"))
    for (const s of candidates) signature(s)
    for (const retry of retries) {
      const chain = yield* lcmPath(sql, userId, chatId, retry.last, retry.first, Number.MAX_SAFE_INTEGER, identities)
      signatures[`retry:${retry.ask.id}`] = createHash("sha256")
        .update(JSON.stringify([chain.map(slotInput), retry.children.map((id) => byId.get(id)?.revisionId)]))
        .digest("hex")
    }
    const authorizedRetries = retries.filter(
      (r) => options.reason === "reply" || previous?.signatures[`retry:${r.ask.id}`] === signatures[`retry:${r.ask.id}`]
    )
    // Legacy/imported leaves can span more than the new slot cap. Continue their explicit
    // request over bounded parts even after its queue row was consumed by the first part.
    // Only a leaf is cut into parts: a condensation is one job whatever its range, so
    // forcing it again after it completed would condense the same parts without end.
    if (options.reason === "completion")
      for (const [id, ask] of Object.entries(previous?.largeRequests ?? {})) {
        const source = byId.get(id)
        if (source && source.level === 1 && previous?.signatures[id] === signatures[id]) {
          forced.set(id, ask)
          chains.set(id, path.slice(source.from - 1, source.to))
        }
      }
    const finishedParts = yield* sql<{
      source: string
      result: string
      rerun_ids_json: string | null
    }>`SELECT source_summary_id AS source,result_summary_id AS result,rerun_ids_json
      FROM summarization_jobs WHERE chat_id=${chatId} AND (fork_id IS NULL OR fork_id=${fork}) AND source_summary_id IS NOT NULL AND status='complete'
        AND audience_json IS ${audience}`
    const completed = new Map<string, Array<Summary>>()
    for (const part of finishedParts) {
      const result = byId.get(part.result)
      const asks = part.rerun_ids_json ? (JSON.parse(part.rerun_ids_json) as Array<string>) : [""]
      if (result?.fresh)
        for (const ask of asks) {
          const key = `${part.source}:${ask}`
          completed.set(key, [...(completed.get(key) ?? []), result])
        }
    }
    const explicit = new Set(previous?.explicit ?? [])
    if (options.reason === "reply") {
      explicit.clear()
      const containsRequest = (s: Summary): boolean =>
        forced.has(s.id) ||
        s.children.some((c) => {
          const child = byId.get(c.summaryId)
          return child !== undefined && containsRequest(child)
        })
      for (const s of candidates) if (containsRequest(s)) explicit.add(s.id)
    }
    const authorized =
      options.reason === "reply"
        ? undefined
        : new Set(candidates.filter((s) => previous?.signatures[s.id] === signatures[s.id]).map((s) => s.id as string))
    // Fresh results of queued work can join ordinary condensation, but never authorize a stale repair.
    if (authorized)
      for (const s of candidates)
        if (s.fresh && s.origin === "generated" && previous?.signatures[s.id] === undefined) authorized.add(s.id)
    const plan = options.planner.plan({
      ...(authorized ? { authorized } : {}),
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
      forced: new Set(forced.keys()),
      reason: options.reason,
      settings: {
        fanout,
        condenseTarget,
        eagerMinChildren: 2,
        absorbMaxChildren: fanout * 2,
        // Each summary is its own message (`summaryBlock`), as the assembly sends it.
        layerCost: layer.summaries.reduce(
          (n, summary) => n + (summary.content === "" ? 0 : tokensOf({ content: summaryBlock(summary) })),
          0
        ),
        layerTarget: options.budget.target,
        layerMax: options.budget.maximum,
        lastFinishedEager: last?.eager === 1
      }
    })
    const chunkFor = (chain: ReadonlyArray<LcmSlot>, ask?: Ask, source?: Summary) =>
      !chain.length || chain.some((c) => c.generating) || !chain.some((c) => c.versionId !== null)
        ? []
        : Array.from({ length: Math.ceil(chain.length / MAX_CHUNK_SLOTS) }, (_, n) => ({
            inputs: chain.slice(n * MAX_CHUNK_SLOTS, (n + 1) * MAX_CHUNK_SLOTS).map(slotInput),
            target: options.leafTarget,
            clipTokens: options.clipTokens,
            refresh: true,
            explicitRequested: source !== undefined && explicit.has(source.id),
            ...(source ? { sourceSummaryId: source.id, sourceRevisionId: source.revisionId } : {}),
            ...(ask ? { rerunIds: [ask.id], ...(ask.model ? { model: ask.model } : {}) } : {})
          })).filter(
            (chunk) =>
              !source ||
              source.slotCount <= MAX_CHUNK_SLOTS ||
              !completed
                .get(`${source.id}:${ask?.id ?? ""}`)
                ?.some(
                  (part) =>
                    part.firstSlotId === chunk.inputs[0]!.slotId && part.lastSlotId === chunk.inputs.at(-1)!.slotId
                )
          )
    // Requests first, then what staleness asks for. A slot still being written, or a merge, can't be
    // summarized; the next pass will see it.
    const refresh = [
      ...(yield* Effect.forEach(
        authorizedRetries.filter((r) => r.level === 1),
        (r) =>
          Effect.map(lcmPath(sql, userId, chatId, r.last, r.first, Number.MAX_SAFE_INTEGER, identities), (chain) =>
            chunkFor(chain, r.ask)
          )
      )).flat(),
      ...[...plan.resummarize]
        .sort((a, b) => Number(forced.has(b)) - Number(forced.has(a)))
        .flatMap((id) => chunkFor(chains.get(id) ?? [], forced.get(id), byId.get(id)))
    ]
    const condensations: Array<PlannedJob> = [
      ...authorizedRetries
        .filter((r) => r.level > 1 && r.children.length > 1)
        .map((r) => ({
          level: r.level,
          children: r.children as unknown as PlannedJob["children"],
          target: condenseTarget,
          eager: false,
          rerunIds: [r.ask.id],
          ...(r.ask.model ? { model: r.ask.model } : {})
        })),
      ...plan.condensations.map((c) => {
        const ask = c.rerunOf ? forced.get(c.rerunOf) : undefined
        return {
          level: c.level,
          children: c.children as PlannedJob["children"],
          target: condenseTarget,
          eager: c.eager,
          explicitRequested: explicit.has(c.sourceOf ?? c.rerunOf ?? c.absorbedParentId ?? ""),
          ...((c.sourceOf ?? c.rerunOf ?? c.absorbedParentId) &&
          byId.get((c.sourceOf ?? c.rerunOf ?? c.absorbedParentId)!)
            ? {
                sourceSummaryId: byId.get((c.sourceOf ?? c.rerunOf ?? c.absorbedParentId)!)!.id,
                sourceRevisionId: byId.get((c.sourceOf ?? c.rerunOf ?? c.absorbedParentId)!)!.revisionId
              }
            : {}),
          ...(c.absorbedParentId ? { absorbedParentId: c.absorbedParentId as never } : {}),
          ...(ask ? { rerunIds: [ask.id], ...(ask.model ? { model: ask.model } : {}) } : {})
        }
      })
    ]
    return {
      ...(options.reason === "reply"
        ? {
            maintenancePins: JSON.stringify({
              signatures,
              askModels,
              largeRequests: Object.fromEntries(
                [...forced].filter(([id]) => {
                  const source = byId.get(id)
                  return source?.level === 1 && source.slotCount > MAX_CHUNK_SLOTS
                })
              ),
              explicit: [...explicit],
              asks: [...forced.values(), ...retries.map((r) => r.ask)].map((a) => a.id)
            } satisfies Pins)
          }
        : {}),
      condensations: condensations.slice(0, MAX_JOBS_PER_PLAN),
      refresh: refresh.slice(0, MAX_JOBS_PER_PLAN),
      flagged: plan.flagged as Array<Summary["id"]>
    }
  })
