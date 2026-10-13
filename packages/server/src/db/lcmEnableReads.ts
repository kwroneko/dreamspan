import { contextExcluded } from "./lcmVisibility.ts"
// What enabling LCM on a chat takes (spec/LCM.md §2.7, §2.11), measured in one read: the
// imported summary that could stand in for its hidden run, and the work the planner would do
// from the first message or after that summary. The counts are priced on the main thread, where
// the cost formulas are.
import { foldState } from "@rp/shared/state.ts"
import type { BackfillCounts } from "@rp/shared/lcm.ts"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { makeAssembler } from "../assembler/assembler.ts"
import { AssemblySources, type PositionedEvent } from "../assembler/pipeline.ts"
import { AssemblyFailed } from "../assembler/types.ts"
import { estimateTokens, tokensOf } from "../assembler/st.ts"
import { backfillSeconds, estimateBackfill } from "../lcm/backfill.ts"
import { sqlSources } from "./assemblySources.ts"
import { backfillOf, overCap, spentSince } from "./lcmBackfill.ts"
import { importedSummary } from "./lcmImported.ts"
import { selectSummaryLayer } from "./lcmLayer.ts"
import { lcmPath } from "./lcmPath.ts"
import { NotFound, type ReadOps, StorageError } from "./ops.ts"
import { query } from "./tx.ts"

/** The speed of the model's last requests, for how long the work takes; null without any. */
const recentSpeed = (sql: SqlClient.SqlClient, userId: string, modelId: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ latency: number | null; tps: number | null }>`
      SELECT avg(first_token_at - started_at) / 1000.0 AS latency,
        sum(output) * 1000.0 / nullif(sum(ended_at - first_token_at), 0) AS tps
      FROM (SELECT first_token_at, started_at, ended_at, output FROM llm_requests
        WHERE owner_user_id = ${userId} AND model_id = ${modelId} AND status = 'complete' AND output > 0
          AND first_token_at IS NOT NULL ORDER BY started_at DESC LIMIT 30)`
    return row?.latency != null && row.tps != null && row.tps > 0
      ? { latencyS: row.latency, tokensPerSecond: row.tps }
      : null
  })

export const makeLcmEnableReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* makeAssembler

  /** The messages after depth `after` that the planner would count, and their tokens. */
  const tail = (leafSlotId: string, after: number, shownThrough: number) =>
    sql<{ n: number; tokens: number }>`WITH RECURSIVE path(id, parent, depth) AS (
        SELECT id, parent_slot_id, depth FROM slots WHERE id = ${leafSlotId} AND depth > ${after}
        UNION ALL SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN path p ON s.id = p.parent
          WHERE s.depth > ${after}
      ) SELECT count(*) AS n, coalesce(sum((length(v.content) + 3) / 4 + 3), 0) AS tokens
        FROM path p JOIN slots s ON s.id = p.id JOIN versions v ON v.id = s.selected_version_id
        WHERE s.deleted_at IS NULL AND s.purged_at IS NULL AND (${sql.literal(contextExcluded())} = 0 OR s.depth <= ${shownThrough})
          AND v.deleted_at IS NULL AND v.purged_at IS NULL AND v.status NOT IN ('generating', 'failed')
          AND length(v.content) > 0`.pipe(Effect.map(([row]) => row ?? { n: 0, tokens: 0 }))

  return {
    ReadLcmImported: ({ userId, chatId, leafSlotId }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql`SELECT 1 FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${leafSlotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "chat", id: chatId })
        const [existing] = yield* sql`SELECT 1 FROM summaries WHERE chat_id = ${chatId} AND sealed = 1 LIMIT 1`
        return existing ? null : yield* importedSummary(sql, userId, chatId, leafSlotId)
      }).pipe(query("ReadLcmImported")),
    GetBackfill: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [owned] =
          yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "chat", id: chatId })
        const row = yield* backfillOf(sql, chatId)
        if (!row) return null
        const spent = yield* spentSince(sql, chatId, row.startedAt)
        const state =
          row.status === "complete"
            ? ("done" as const)
            : row.paused
              ? ("paused" as const)
              : row.capped || overCap(row, spent)
                ? ("capped" as const)
                : row.armed
                  ? ("waiting" as const)
                  : ("running" as const)
        return {
          state,
          choice: row.choice,
          startedAt: row.startedAt,
          armed: row.armed,
          paused: row.paused,
          capped: row.capped,
          drive: row.drive,
          spentTokens: spent.tokens,
          spentCost: spent.cost,
          capTokens: row.capTokens,
          capCost: row.capCost,
          currency: row.currency ?? spent.currency
        }
      }).pipe(query("GetBackfill")),

    EstimateBackfill: ({ userId, chatId, leafSlotId }) =>
      Effect.gen(function* () {
        yield* lcmPath(sql, userId, chatId, leafSlotId, leafSlotId)
        const sources = sqlSources(sql, { userId, chatId, next: true, cut: leafSlotId })
        const base = yield* Effect.map(AssemblySources, (s) => s).pipe(Effect.provide(sources.layer))
        const events = yield* base.events(leafSlotId)
        const state = foldState(events.map((e) => e.event))
        // The assembler measures the window only for a chat with LCM on, so it is built as if it were.
        const forced: PositionedEvent = {
          depth: null,
          event: { scope: null, data: { key: "lcm.settings", value: { ...state.lcm, enabled: true } } }
        }
        const layer = Layer.succeed(AssemblySources)({
          ...base,
          events: (at) => Effect.map(base.events(at), (read) => [...read, forced])
        })
        const bound =
          state.modelBindings["summarizer"] ?? state.modelBindings["narrator"] ?? state.modelBindings[""] ?? null
        const narrator = state.modelBindings["narrator"] ?? state.modelBindings[""] ?? null
        const model = yield* base.model(bound).pipe(Effect.catchTag("AssemblyFailed", () => Effect.succeed(null)))
        const narrating = yield* base
          .model(narrator)
          .pipe(Effect.catchTag("AssemblyFailed", () => Effect.succeed(null)))
        const none = {
          messages: 0,
          tokens: 0,
          l1Jobs: 0,
          condensations: 0,
          uncachedInput: 0,
          cachedInput: 0,
          cacheWrite: 0,
          output: 0,
          cached: false,
          model: null,
          blocked: null,
          seconds: null
        } satisfies BackfillCounts
        const enabled = state.lcm?.enabled === true
        const summaries = yield* selectSummaryLayer(sql, userId, chatId, leafSlotId)
        const imported = yield* importedSummary(sql, userId, chatId, leafSlotId)
        const [lastRow] = imported
          ? yield* sql<{ depth: number }>`SELECT depth FROM slots WHERE id = ${imported.lastSlotId}`
          : []
        const adoptable = imported !== null && lastRow !== undefined && summaries.summaries.length === 0
        const offer = adoptable
          ? {
              to: lastRow.depth + 1,
              tokens: tokensOf({ content: imported.content }),
              hidden: imported.hidden,
              preview: imported.content.slice(0, 400)
            }
          : null
        if (model === null) {
          const blocked = { ...none, blocked: "no_model" as const }
          return { enabled, imported: offer, fromScratch: blocked, adopted: offer ? blocked : null }
        }
        const built = yield* assembler
          .assemble({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random })
          .pipe(Effect.provide(layer))
          .pipe(Effect.catchTag("AssemblyFailed", (error: AssemblyFailed) => Effect.succeed(error)))
        const info = {
          connection: model.connectionId as never,
          model: model.modelId as never,
          name: model.key,
          sharesCache: narrating?.modelId === model.modelId
        }
        const blockedWith = (blocked: "runway") => ({ ...none, model: info, blocked })
        if (built instanceof AssemblyFailed) {
          const blocked = blockedWith("runway")
          return { enabled, imported: offer, fromScratch: blocked, adopted: offer ? blocked : null }
        }
        const windowMax = Math.max(0, Math.floor(built.historyBudget ?? 0))
        const leafInput = state.lcm?.leafInput ?? Math.min(4000, Math.floor(windowMax / 8))
        if (leafInput < 1 || leafInput * 2 > windowMax / 4) {
          const blocked = blockedWith("runway")
          return { enabled, imported: offer, fromScratch: blocked, adopted: offer ? blocked : null }
        }
        // What opens every request: the messages that are neither history nor summaries.
        const inHistory = new Set<number>()
        for (const piece of built.pieces)
          if (piece.source.kind === "message" || piece.source.kind === "summary")
            for (const message of piece.messages) inHistory.add(message)
        const prefix = built.request.messages.reduce((n, m, at) => n + (inHistory.has(at) ? 0 : tokensOf(m)), 0)
        const speed = yield* recentSpeed(sql, userId, model.modelId)
        const [priced] = yield* sql<{ write: number | null }>`
          SELECT json_extract(upstream_json, '$.price.cacheWrite') AS write FROM models WHERE id = ${model.modelId}`
        const layerTokens = summaries.summaries.reduce((n, s) => n + s.tokens, 0)
        const work = (after: number, shownThrough: number, layerBefore: number) =>
          Effect.gen(function* () {
            const rest = yield* tail(leafSlotId, after, shownThrough)
            const totals = estimateBackfill({
              tokens: rest.tokens,
              messages: rest.n,
              windowMax,
              layerMax: built.lcm?.layerBudget?.maximum ?? Number.MAX_SAFE_INTEGER,
              prefix,
              layer: layerBefore,
              leafInput,
              leafTarget: state.lcm?.leafTarget ?? 600,
              fanout: state.lcm?.fanout ?? 5,
              condenseTarget: state.lcm?.condenseTarget ?? 800,
              cached: (model.cacheTtlS ?? 0) > 0,
              cacheWrites: (priced?.write ?? 0) > 0
            })
            return {
              messages: rest.tokens > 0 ? Math.round((rest.n * totals.summarized) / rest.tokens) : 0,
              tokens: totals.summarized,
              plannedRequests: totals.plannedRequests,
              l1Jobs: totals.l1Jobs,
              condensations: totals.condensations,
              uncachedInput: totals.uncachedInput,
              cachedInput: totals.cachedInput,
              cacheWrite: totals.cacheWrite,
              output: totals.output,
              cached: (model.cacheTtlS ?? 0) > 0,
              model: info,
              blocked: null,
              seconds: backfillSeconds(totals, speed)
            } satisfies BackfillCounts
          })
        // Without the imported summary, the run is shown and summarized with the rest.
        const fromScratch = yield* work(summaries.cursorDepth, adoptable ? lastRow.depth : -1, layerTokens)
        const adopted = adoptable
          ? yield* work(
              Math.max(summaries.cursorDepth, lastRow.depth),
              -1,
              layerTokens + estimateTokens(imported.content)
            )
          : null
        return { enabled, imported: offer, fromScratch, adopted }
      }).pipe(
        // A document the sources can't read means nothing can be assembled to measure.
        Effect.catchTag("AssemblyFailed", (error) =>
          Effect.fail(new StorageError({ operation: "EstimateBackfill", reason: "constraint", message: error.message }))
        ),
        query("EstimateBackfill")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
