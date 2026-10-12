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
        if (next instanceof AssemblyFailed || next.inputs.model?.cacheTtlS == null) return null
        const ttlS = next.inputs.model.cacheTtlS
        const changed = prefixChange(previous, next, yield* describer(sql, userId, chatId, [previous, next]))
        return {
          lastRequestAt: last.started_at,
          ttlS,
          expiresAt: last.started_at + (previous.inputs.model?.cacheTtlS ?? 0) * 1000,
          verified: (last.cache_read ?? 0) + (last.cache_write ?? 0) > 0,
          prefixTokens: tokensBetween(previous, 0, end),
          changed
        }
      }).pipe(query("CacheWarmth")),

    GetGenerationDefaults: ({ userId }) => readDefaults(sql, userId).pipe(query("GetGenerationDefaults"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
