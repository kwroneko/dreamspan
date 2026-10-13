// Context assembly and rebuilding in the reader workers (ARCHITECTURE §15).
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeAssembler } from "../assembler/assembler.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { wireContext } from "../assembler/wire.ts"
import { lastBreakpoint, prefixChange, tokensBetween } from "../assembler/warmth.ts"
import { describer, inspectionInputs } from "./inspectorReads.ts"
import { NotFound } from "@rp/shared/errors.ts"
import {
  ASSEMBLER_VERSION,
  AssemblyFailed,
  type ContextSnapshot,
  type WireContext,
  generationOf
} from "../assembler/types.ts"
import { sqlSources } from "./assemblySources.ts"
import { readDefaults } from "./generationSettings.ts"
import type { ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeAssemblyReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* makeAssembler
  const handlers = {
    AssembleContext: ({ userId, chatId, slotId, versionId, now, timeZone, frozen }) =>
      Effect.suspend(() => {
        const sources = sqlSources(sql, { userId, chatId, slotId, versionId })
        return assembler.assemble({ now, timeZone, frozen: frozen ?? {}, random: Math.random }).pipe(
          Effect.provide(sources.layer),
          Effect.flatMap((built) =>
            Effect.gen(function* () {
              const snapshot: ContextSnapshot = {
                ...built,
                sources: sources.pins(),
                ...(built.inputs.model ? { wire: wireContext(built.request, built.inputs.model) } : {})
              }
              const inspection = yield* inspectionInputs(sql, userId, snapshot)
              return {
                snapshot: JSON.stringify(snapshot),
                generation: JSON.stringify({ ...generationOf(snapshot), inspection })
              }
            })
          )
        )
      }).pipe(query("AssembleContext")),

    RebuildContext: ({ userId, snapshot: json }) =>
      Effect.gen(function* () {
        const taken = JSON.parse(json) as ContextSnapshot
        if ((taken.assemblerVersion ?? 0) !== ASSEMBLER_VERSION) {
          return {
            _tag: "EarlierAssemblerVersion" as const,
            assemblerVersion: taken.assemblerVersion ?? 0,
            currentVersion: ASSEMBLER_VERSION,
            storedSnapshot: json
          }
        }
        if (!taken.sources) {
          return yield* new AssemblyFailed({
            reason: "invalid_document",
            message: "The context can't be built again: it was taken before contexts pinned what they read."
          })
        }
        const { inputs } = taken
        const sources = sqlSources(
          sql,
          { userId, chatId: inputs.chatId as ChatId, slotId: inputs.slotId, versionId: inputs.versionId },
          { pins: taken.sources, inputs }
        )
        const built = yield* assembler
          .assemble({
            now: inputs.now,
            timeZone: inputs.timeZone,
            frozen: taken.frozen,
            random: Math.random,
            ...(taken.loreFallback ? { loreFallback: taken.loreFallback } : {})
          })
          .pipe(Effect.provide(sources.layer))
        return {
          _tag: "Rebuilt" as const,
          snapshot: JSON.stringify({
            ...built,
            sources: sources.pins(),
            ...(taken.wire ? { wire: taken.wire } : {})
          })
        }
      }).pipe(query("RebuildContext")),

    // The cache-warmth estimate (DESIGN §5.5): the chat's last request that reached its
    // provider and the next request's TTL eligibility and prefix at the end of the active path
    // compared up to its last breakpoint. Null when there's nothing to estimate.
    CacheWarmth: ({ userId, chatId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: string }>`
          SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const [last] = yield* sql<{
          started_at: number
          cache_read: number | null
          cache_write: number | null
          model_id: string | null
          sent_context_json: string | null
          snapshot: string | null
        }>`
          SELECT q.started_at, q.cache_read, q.cache_write, q.model_id,
            p.context_snapshot_json AS snapshot, p.sent_context_json
          FROM llm_requests q JOIN rollout_payloads p ON p.rollout_id = q.rollout_id
          WHERE q.chat_id = ${chatId} AND q.owner_user_id = ${userId}
            AND (q.status IN ('running', 'complete') OR q.first_token_at IS NOT NULL)
          ORDER BY q.started_at DESC, q.id DESC LIMIT 1`
        if (!last?.snapshot || last.model_id === null) return null
        const saved = JSON.parse(last.snapshot) as ContextSnapshot
        const previous = {
          ...saved,
          ...(last.sent_context_json ? { wire: JSON.parse(last.sent_context_json) as WireContext } : {})
        }
        const end = lastBreakpoint(previous)
        const sources = sqlSources(sql, { userId, chatId, next: true })
        const next = yield* assembler
          .assemble({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random })
          .pipe(
            Effect.provide(sources.layer),
            Effect.map((built): ContextSnapshot => ({ ...built, sources: sources.pins() })),
            Effect.catchTag("AssemblyFailed", (error) => Effect.succeed(error))
          )
        if (next instanceof AssemblyFailed || !next.inputs.model) return null
        const sameModel =
          next.inputs.model.modelId === previous.inputs.model?.modelId &&
          next.inputs.model.connectionId === previous.inputs.model?.connectionId
        const ttlS =
          !next.inputs.model.cacheTtlOverride && sameModel
            ? previous.wire?.cache
              ? previous.wire.cache.ttlS
              : next.inputs.model.cacheTtlS
            : next.inputs.model.cacheTtlS
        if (ttlS == null) return null
        const changed = prefixChange(previous, next, yield* describer(sql, userId, chatId, [previous, next]))
        let origin = last.started_at
        let originSnapshot = previous
        if ((last.cache_read ?? 0) > 0 && (last.cache_write ?? 0) === 0) {
          // Fixed-lived caches (Cerebras, OpenRouter explicit Gemini) do not slide
          // on a hit. Find the matching prefix's write/miss, never a newer unrelated one.
          const candidates = yield* sql<{ started_at: number; snapshot: string; sent: string | null }>`
            SELECT q.started_at, p.context_snapshot_json AS snapshot, p.sent_context_json AS sent
            FROM llm_requests q JOIN rollout_payloads p ON p.rollout_id = q.rollout_id
            WHERE q.chat_id = ${chatId} AND q.owner_user_id = ${userId} AND q.model_id = ${last.model_id}
              AND q.started_at <= ${last.started_at} AND q.status = 'complete' AND p.context_snapshot_json IS NOT NULL
              AND (q.cache_read = 0 OR q.cache_write > 0)
            ORDER BY q.started_at DESC, q.id DESC LIMIT 100`
          const descriptions = yield* describer(sql, userId, chatId, [previous])
          let write: { startedAt: number; snapshot: ContextSnapshot } | undefined
          for (const row of candidates) {
            const snapshot = {
              ...(JSON.parse(row.snapshot) as ContextSnapshot),
              ...(row.sent ? { wire: JSON.parse(row.sent) as WireContext } : {})
            }
            if (prefixChange(snapshot, previous, descriptions) === null) {
              write = { startedAt: row.started_at, snapshot }
              break
            }
          }
          // A hit proves reuse, but without its original write time cannot date expiry.
          if (previous.wire?.cache?.fixed && !write) return null
          // A later transform can change the requested mode, but a hit cannot
          // rewrite the lifetime established by an earlier fixed-cache write.
          if (write && (previous.wire?.cache?.fixed || write.snapshot.wire?.cache?.fixed)) {
            origin = write.startedAt
            originSnapshot = write.snapshot
          }
        }
        const historicalTtl = originSnapshot.wire?.cache
          ? originSnapshot.wire.cache.ttlS
          : originSnapshot.inputs.model?.cacheTtlS
        if (historicalTtl == null) return null
        return {
          lastRequestAt: last.started_at,
          ttlS,
          expiresAt: origin + historicalTtl * 1000,
          verified: (last.cache_read ?? 0) + (last.cache_write ?? 0) > 0,
          prefixTokens: tokensBetween(previous, 0, end),
          changed
        }
      }).pipe(query("CacheWarmth")),

    GetGenerationDefaults: ({ userId }) => readDefaults(sql, userId).pipe(query("GetGenerationDefaults"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
