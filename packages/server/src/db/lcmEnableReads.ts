import { contextExcludedIn } from "./lcmVisibility.ts"
// What enabling LCM on a chat takes (spec/LCM.md §2.7, §2.11), measured in one read: the
// imported summary that could stand in for its hidden run, and the work the planner would do
// from the first message or after that summary. The counts are priced on the main thread, where
// the cost formulas are.
import { foldState, noteSwitches } from "@rp/shared/state.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { inFork, shownIn, shownVersionDeletedIn, slotDeletedIn, viewAt } from "./forkState.ts"
import type { BackfillCounts } from "@rp/shared/lcm.ts"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { makeAssembler } from "../assembler/assembler.ts"
import { AssemblySources, type PositionedEvent } from "../assembler/pipeline.ts"
import { AssemblyFailed } from "../assembler/types.ts"
import { estimateTokens, tokensOf } from "../assembler/st.ts"
import { backfillSeconds, estimateBackfill, layerTokens } from "../lcm/backfill.ts"
import { sqlSources } from "./assemblySources.ts"
import { backfillOf, overCap, spentSince } from "./lcmBackfill.ts"
import { importedSummary, importedSummaryNotes } from "./lcmImported.ts"
import { selectSummaryLayer } from "./lcmLayer.ts"
import { lcmPath } from "./lcmPath.ts"
import { NotFound, type ReadOps, StorageError } from "./ops.ts"
import { query } from "./tx.ts"
import { readDefaults } from "./generationSettings.ts"
import { chunkSize, lcmMisfits, resolveLcm } from "@rp/shared/lcmSettings.ts"

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
  const tail = (chatId: string, leafSlotId: string, after: number, shownThrough: number) =>
    Effect.flatMap(
      viewAt(sql, chatId, leafSlotId),
      (fork) => sql<{ n: number; tokens: number }>`WITH RECURSIVE path(id, parent, depth) AS (
        SELECT id, parent_slot_id, depth FROM slots WHERE id = ${leafSlotId} AND depth > ${after}
        UNION ALL SELECT s.id, s.parent_slot_id, s.depth FROM slots s JOIN path p ON s.id = p.parent
          WHERE s.depth > ${after}
      ) SELECT count(*) AS n, coalesce(sum((length(v.content) + 3) / 4 + 3), 0) AS tokens
        FROM path p JOIN slots s ON s.id = p.id JOIN versions v ON v.id = ${shownIn(sql, fork, "s")}
        WHERE NOT ${slotDeletedIn(sql, fork, "s")} AND (${contextExcludedIn(sql, fork)} = 0 OR s.depth <= ${shownThrough})
          AND NOT ${shownVersionDeletedIn(sql, fork, "v")} AND v.status NOT IN ('generating', 'failed')
          AND length(v.content) > 0`
    ).pipe(Effect.map(([row]) => row ?? { n: 0, tokens: 0 }))

  return {
    // The settings panel (DESIGN §8): what the chat stores, what applies, and the fit, measured on
    // one assembly of the next context with LCM on, as the planner would see it.
    LcmSettingsAt: ({ userId, chatId, leafSlotId, forkId }) =>
      Effect.gen(function* () {
        const [chat] =
          yield* sql`SELECT 1 FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const sources = sqlSources(sql, { userId, chatId, next: true, leafSlotId })
        const base = yield* Effect.map(AssemblySources, (s) => s).pipe(Effect.provide(sources.layer))
        const at = (yield* base.target).parentSlotId
        const state = foldState((yield* base.events(at)).map((e) => e.event))
        const account = (yield* readDefaults(sql, userId)).lcm ?? null
        const resolved = resolveLcm(state.lcm, account)
        const forced: PositionedEvent = {
          depth: null,
          event: { scope: null, data: { key: "lcm.settings", value: { ...state.lcm, enabled: true } } }
        }
        const layer = Layer.succeed(AssemblySources)({
          ...base,
          events: (slot) => Effect.map(base.events(slot), (read) => [...read, forced])
        })
        const built = yield* assembler
          .assemble({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random })
          .pipe(
            Effect.provide(layer),
            Effect.map((snapshot) => snapshot.lcm ?? null),
            Effect.catchTag("AssemblyFailed", () => Effect.succeed(null))
          )
        const measure = built?.measure
        const fitted =
          built?.recentBudget && built.layerBudget && measure
            ? {
                recent: { ...built.recentBudget, clamped: measure.recentClamped },
                layer: { ...built.layerBudget, clamped: measure.layerClamped },
                chunk: chunkSize(resolved.leafInput, built.recentBudget)
              }
            : null
        const room = measure ? { context: measure.context, fixed: measure.fixed, reply: measure.reply } : null
        return {
          stored: state.lcm,
          resolved,
          account,
          fitted,
          room,
          now: measure ? { recent: measure.recentNow, layer: measure.layerNow } : null,
          fit: lcmMisfits(resolved, room, built?.recentBudget)
        }
      }).pipe(
        // Only reading the leaf's state can fail this way: a leaf that isn't the chat's.
        Effect.catchTag("AssemblyFailed", () =>
          Effect.fail(new NotFound({ entity: "slot", id: leafSlotId ?? chatId }))
        ),
        inFork(sql, chatId, forkId, leafSlotId),
        query("LcmSettingsAt")
      ),
    ReadLcmImported: ({ userId, chatId, leafSlotId, forkId }) =>
      Effect.gen(function* () {
        const [owned] = yield* sql`SELECT 1 FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${leafSlotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!owned) return yield* new NotFound({ entity: "chat", id: chatId })
        const [existing] = yield* sql`SELECT 1 FROM summaries WHERE chat_id = ${chatId} AND sealed = 1 LIMIT 1`
        return existing ? null : yield* importedSummary(sql, userId, chatId, leafSlotId)
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("ReadLcmImported")),
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

    EstimateBackfill: ({ userId, chatId, leafSlotId, forkId }) =>
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
        // Enabling switches the imported summary off where it's on (DESIGN §8 [P]); the dialog says so.
        const switches = noteSwitches(events.map((e) => e.event))
        const notesOn = (yield* importedSummaryNotes(sql, userId, chatId)).filter((id) => switches.get(id) === true)
        const noted = notesOn.length ? { summaryNotesOn: notesOn as Array<EntityId> } : {}
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
          return { enabled, imported: offer, fromScratch: blocked, adopted: offer ? blocked : null, ...noted }
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
          return { enabled, imported: offer, fromScratch: blocked, adopted: offer ? blocked : null, ...noted }
        }
        const settings = resolveLcm(state.lcm, (yield* readDefaults(sql, userId)).lcm)
        const recent = built.lcm?.recentBudget ?? { target: 0, maximum: 0 }
        const leafInput = chunkSize(settings.leafInput, recent)
        if (leafInput < 1 || leafInput * 2 > recent.maximum - recent.target) {
          const blocked = blockedWith("runway")
          return { enabled, imported: offer, fromScratch: blocked, adopted: offer ? blocked : null, ...noted }
        }
        // What opens every request: the messages that are neither history nor summaries, nor
        // what only a reply sends (a conditioned prompt, the user turn that ends a reply's request:
        // a summary request sends neither, DESIGN §2.2).
        const notPrefix = new Set<number>()
        const replyOnly = new Map<number, boolean>()
        for (const piece of built.pieces) {
          if (piece.source.kind === "message" || piece.source.kind === "summary")
            for (const message of piece.messages) notPrefix.add(message)
          const only =
            (piece.source.kind === "preset" && piece.source.condition !== undefined) ||
            (piece.source.kind === "assembler" && piece.id === "assembler:last-turn")
          for (const message of piece.messages) replyOnly.set(message, (replyOnly.get(message) ?? true) && only)
        }
        for (const [message, only] of replyOnly) if (only) notPrefix.add(message)
        const prefix = built.request.messages.reduce((n, m, at) => n + (notPrefix.has(at) ? 0 : tokensOf(m)), 0)
        const speed = yield* recentSpeed(sql, userId, model.modelId)
        const [priced] = yield* sql<{ write: number | null }>`
          SELECT json_extract(upstream_json, '$.price.cacheWrite') AS write FROM models WHERE id = ${model.modelId}`
        const sizes = summaries.summaries.map((s) => s.tokens)
        const work = (after: number, shownThrough: number, layerBefore: number) =>
          Effect.gen(function* () {
            const rest = yield* tail(chatId, leafSlotId, after, shownThrough)
            const totals = estimateBackfill({
              tokens: rest.tokens,
              messages: rest.n,
              recentTarget: recent.target,
              recentMax: recent.maximum,
              withPreset: settings.withPreset,
              layerMax: built.lcm?.layerBudget?.maximum ?? Number.MAX_SAFE_INTEGER,
              prefix,
              layer: layerBefore,
              leafInput,
              leafTarget: settings.leafTarget,
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
        const fromScratch = yield* work(summaries.cursorDepth, adoptable ? lastRow.depth : -1, layerTokens(sizes))
        const adopted = adoptable
          ? yield* work(
              Math.max(summaries.cursorDepth, lastRow.depth),
              -1,
              layerTokens([...sizes, estimateTokens(imported.content)])
            )
          : null
        return { enabled, imported: offer, fromScratch, adopted, ...noted }
      }).pipe(
        inFork(sql, chatId, forkId, leafSlotId),
        // A document the sources can't read means nothing can be assembled to measure.
        Effect.catchTag("AssemblyFailed", (error) =>
          Effect.fail(new StorageError({ operation: "EstimateBackfill", reason: "constraint", message: error.message }))
        ),
        query("EstimateBackfill")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
