import { presetContext } from "./presetContext.ts"
import { cacheExpiry } from "./cacheExpiry.ts"
import { summaryRequest } from "../lcm/request.ts"
import { atLeaf, inFork } from "./forkState.ts"
// Context assembly and rebuilding in the reader workers (ARCHITECTURE §15).
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { makeAssembler } from "../assembler/assembler.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { BUILTIN_PRESET_LABEL } from "@rp/shared/generation.ts"
import type { EffectivePreset } from "@rp/shared/inspectorApi.ts"
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
import { previousHistoryStart } from "./historyStart.ts"
import { readDefaults, readGlobalLorebooks } from "./generationSettings.ts"
import { readCardPromptUse } from "./lorebookSettings.ts"
import { makeDisplayPrefsReadHandlers } from "./displayPrefs.ts"
import type { ReadOps } from "./ops.ts"
import { query } from "./tx.ts"

export const makeAssemblyReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* makeAssembler
  const handlers = {
    ...(yield* makeDisplayPrefsReadHandlers),
    AssembleContext: ({ userId, chatId, slotId, versionId, forkId, now, timeZone, frozen, partialBatch, model }) =>
      Effect.suspend(() => {
        const sources = sqlSources(sql, {
          userId,
          chatId,
          slotId,
          versionId,
          ...(partialBatch === undefined ? {} : { partialBatch }),
          ...(model === undefined ? {} : { modelOverride: model })
        })
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
      }).pipe(inFork(sql, chatId, forkId, slotId), query("AssembleContext")),

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
            ...(taken.summaryJob
              ? {
                  summarizing: true,
                  summaryClipTokens: taken.summaryJob.clipTokens
                }
              : {}),
            ...(taken.loreFallback ? { loreFallback: taken.loreFallback } : {})
          })
          .pipe(Effect.provide(sources.layer))
        return {
          _tag: "Rebuilt" as const,
          snapshot: JSON.stringify({
            ...(taken.summaryJob
              ? summaryRequest({
                  ...built,
                  summaryJob: taken.summaryJob,
                  request: { ...built.request, samplers: taken.request.samplers }
                })
              : built),
            sources: sources.pins(),
            ...(taken.wire ? { wire: taken.wire } : {})
          })
        }
      }).pipe(query("RebuildContext")),

    // The cache-warmth estimate (DESIGN §5.5): the chat's last request that reached its
    // provider and the next request's TTL eligibility and prefix at the end of the active path
    // compared up to its last breakpoint. Null when there's nothing to estimate.
    CacheWarmth: ({ userId, chatId, leafSlotId }) =>
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
        const sources = sqlSources(sql, { userId, chatId, next: true, leafSlotId: leafSlotId ?? null })
        const next = yield* assembler
          .assemble({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random })
          .pipe(
            Effect.provide(sources.layer),
            Effect.map((built): ContextSnapshot => ({ ...built, sources: sources.pins() })),
            Effect.catchTag("AssemblyFailed", (error) => Effect.succeed(error))
          )
        const [recorded] =
          next instanceof AssemblyFailed
            ? yield* previousHistoryStart(sql, userId, chatId, sources.pins().target.parentSlotId)
            : []
        const fallback = recorded
          ? { slotId: recorded.slot_id, depth: recorded.depth }
          : (sources.pins().historyStart ?? null)
        const start = next instanceof AssemblyFailed ? fallback : (next.historyStart ?? fallback)
        const budget = next.contextBudget
        const preset = next instanceof AssemblyFailed ? next.preset : next.inputs.preset
        const [presetRef] = preset?.ref
          ? yield* sql<{ label: string }>`SELECT r.label FROM entity_refs r JOIN entities e ON e.id = r.entity_id
              WHERE r.id = ${preset.ref} AND e.owner_user_id = ${userId}`
          : []
        const presetName = presetRef?.label ?? (preset?.scope === "builtin" ? BUILTIN_PRESET_LABEL : "Unnamed")
        // The model by name, as the panel shows it: also a hidden one, which is still used.
        const chosen = sources.chosenModel()
        const resolved = sources.resolvedModel()
        const [named] = chosen
          ? yield* sql<{ connection_name: string; model_key: string | null; hidden: number | null }>`
              SELECT c.name AS connection_name, m.model_key, m.hidden
              FROM connections c LEFT JOIN models m ON m.id = ${chosen.model} AND m.connection_id = c.id
              WHERE c.id = ${chosen.connection} AND c.owner_user_id = ${userId}
                AND c.deleted_at IS NULL AND c.purged_at IS NULL`
          : []
        const boundary = {
          presetContext: next instanceof AssemblyFailed ? null : yield* presetContext(sql, userId, next),
          ...(chosen === undefined
            ? {}
            : {
                model: chosen && {
                  connection: chosen.connection,
                  model: chosen.model,
                  connectionName: named?.connection_name ?? null,
                  modelKey: named?.model_key ?? null,
                  hidden: named?.hidden === 1,
                  scope: chosen.scope,
                  // Whether Continue can use it (a prefill), as the next request would read it.
                  ...(resolved
                    ? {
                        prefill: resolved.prefill,
                        ...(resolved.continueUnavailable ? { continueUnavailable: resolved.continueUnavailable } : {})
                      }
                    : {})
                }
              }),
          preset: preset
            ? { ref: preset.ref, name: presetName, scope: preset.scope as EffectivePreset["scope"] }
            : null,
          budget:
            budget && preset
              ? {
                  ...budget,
                  presetName,
                  builtinPreset: preset.scope === "builtin"
                }
              : null,
          leafSlotId: sources.pins().target.parentSlotId,
          historyStart: start ? { slotId: start.slotId, depth: start.depth } : null,
          summarizedThrough: (sources.pins().lcm?.cursorDepth ?? -1) < 0 ? null : sources.pins().lcm!.cursorDepth
        }
        if (next instanceof AssemblyFailed || !next.inputs.model || !last?.snapshot || last.model_id === null) {
          return { ...boundary, warmth: null }
        }
        const saved = JSON.parse(last.snapshot) as ContextSnapshot
        const previous = {
          ...saved,
          ...(last.sent_context_json ? { wire: JSON.parse(last.sent_context_json) as WireContext } : {})
        }
        const end = lastBreakpoint(previous)
        const sameModel =
          next.inputs.model.modelId === previous.inputs.model?.modelId &&
          next.inputs.model.connectionId === previous.inputs.model?.connectionId
        const ttlS =
          (!next.inputs.model.cacheTtlOverride && sameModel
            ? previous.wire?.cache
              ? previous.wire.cache.ttlS
              : next.inputs.model.cacheTtlS
            : next.inputs.model.cacheTtlS) ?? null
        const changed = prefixChange(previous, next, yield* describer(sql, userId, chatId, [previous, next]))
        const expiresAt = yield* cacheExpiry(sql, userId, chatId, last, previous)
        return {
          ...boundary,
          warmth:
            (ttlS === null || expiresAt === null) && changed === null
              ? null
              : {
                  lastRequestAt: last.started_at,
                  ttlS,
                  expiresAt,
                  verified: (last.cache_read ?? 0) + (last.cache_write ?? 0) > 0,
                  prefixTokens: tokensBetween(previous, 0, end),
                  changed
                }
        }
      }).pipe(atLeaf(sql, chatId, leafSlotId ?? null), query("CacheWarmth")),

    GetGenerationDefaults: ({ userId }) => readDefaults(sql, userId).pipe(query("GetGenerationDefaults")),
    GetGlobalLorebooks: ({ userId }) => readGlobalLorebooks(sql, userId).pipe(query("GetGlobalLorebooks")),
    GetCardPromptUse: ({ userId }) => readCardPromptUse(sql, userId).pipe(query("GetCardPromptUse"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
