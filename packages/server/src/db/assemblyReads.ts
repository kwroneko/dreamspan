import { modelName } from "@rp/shared/cardNames.ts"
import { makeExternalMediaReadHandlers } from "./externalMedia.ts"
import { makeSavedMediaReadHandlers } from "./savedMedia.ts"
import type { ContinuousSnapshot } from "../agent/continuity.ts"
import { prepareTextTokens } from "../assembler/textTokens.ts"
import { tokensOf } from "../assembler/st.ts"
import { textDisplay } from "./textDisplay.ts"
import { fitSummaryOutput } from "../lcm/requestBudget.ts"
import { presetContext } from "./presetContext.ts"
import { cacheExpiry } from "./cacheExpiry.ts"
import { inFork, viewAt } from "./forkState.ts"
// Context assembly and rebuilding in the reader workers (ARCHITECTURE §15).
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { withAssemblyModules } from "../assembler/modules.ts"
import { type PreparedRewrite, WorkerAssembler } from "../assembler/assembler.ts"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { ReplySections } from "@rp/shared/replySections.ts"
import { BUILTIN_PRESET_LABEL } from "@rp/shared/generation.ts"
import type { EffectivePreset } from "@rp/shared/inspectorApi.ts"
import { wireContext } from "../assembler/wire.ts"
import { lastBreakpoint, prefixChange, speakerPrefixChange, tokensBetween } from "../assembler/warmth.ts"
import { bestEffortCache, documentedCacheMinimum } from "../providers/cachePolicy.ts"
import { nextImages, estimateImage } from "../assembler/imageTokens.ts"
import { budgetOrigins } from "../assembler/budget.ts"
import { contextMessages, describer, inspectionInputs } from "./inspectorReads.ts"
import { draftSources } from "./draftSources.ts"
import { inspectWire } from "../assembler/inspection.ts"
import { wireImages } from "../assembler/imageTokens.ts"
import type { Assembler } from "../assembler/assembler.ts"
import type { ContextSource } from "@rp/shared/inspectorApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import {
  ASSEMBLER_VERSION,
  AssemblyFailed,
  type ContextSnapshot,
  type WireContext,
  generationOf,
  historyLeafOf
} from "../assembler/types.ts"
import type { RequestImage } from "../assembler/types.ts"
import { sqlSources, readImageTokenFacts } from "./assemblySources.ts"
import { previousStartIn } from "./historyStart.ts"
import { displayThrough } from "./displayPath.ts"
import { readDefaults, readGlobalRegex } from "./generationSettings.ts"
import { readCardPromptUse, readLorebookPresets } from "./lorebookSettings.ts"
import { makeDisplayPrefsReadHandlers } from "./displayPrefs.ts"
import { makeSourcePrefsReadHandlers } from "./sourcePrefs.ts"
import { makeCardOriginReadHandlers } from "./cardOrigins.ts"
import { makeTokenCountingReadHandlers } from "./tokenCounting.ts"
import { makeDecisionReadHandlers } from "./decisions.ts"
import { makeAwayMarkReadHandlers } from "./awayMarks.ts"
import type { ReadOps } from "./ops.ts"
import { usedEntries } from "./usedEntries.ts"
import { query } from "./tx.ts"
import { readingOnce } from "./lcmReads.ts"

/** How many generating replies' prepared rewrites a worker keeps, and for how long unused. */
const LIVE_MAX = 32
const LIVE_IDLE_MS = 10 * 60_000

/**
 * What the next request's estimate says of it, for a saved chat's next reply and a chat not sent
 * yet alike: why it can't be built, the model and preset it uses, and its budget with the
 * request counted by the model's local tokenizer (an approximation where it has none).
 */
const estimateOf = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  assembler: Assembler,
  next: ContextSnapshot | AssemblyFailed,
  sources: Pick<ReturnType<typeof sqlSources>, "chosenModel" | "resolvedModel">
) =>
  Effect.gen(function* () {
    const displayTokens =
      next instanceof AssemblyFailed
        ? null
        : yield* textDisplay(
            sql,
            userId,
            next.inputs.model,
            assembler,
            next.request.messages.map((m) => m.content + (m.name ?? ""))
          )
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
    return {
      assemblyError: next instanceof AssemblyFailed ? next.message : null,
      assemblyErrorReason: next instanceof AssemblyFailed ? next.reason : null,
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
                    vision: resolved.vision,
                    maxImages: resolved.maxImages,
                    ...(resolved.continueUnavailable ? { continueUnavailable: resolved.continueUnavailable } : {})
                  }
                : {})
            }
          }),
      preset: preset ? { ref: preset.ref, name: presetName, scope: preset.scope as EffectivePreset["scope"] } : null,
      budget:
        budget && preset
          ? {
              ...budget,
              ...(displayTokens && !(next instanceof AssemblyFailed)
                ? {
                    countedInput:
                      displayTokens.counts.reduce(
                        (n, c) => n + c,
                        next.request.messages.filter((m) => m.content).length * 3
                      ) + next.request.messages.reduce((n, m) => n + tokensOf({ content: "", images: m.images }), 0),
                    tokenizer: displayTokens.tokenizer
                  }
                : {}),
              presetName,
              builtinPreset: preset.scope === "builtin",
              origins: budgetOrigins(resolved ?? null)
            }
          : null
    }
  })

export const makeAssemblyReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* WorkerAssembler
  /** Prepared rewrites of replies generating now (`RewriteLive`), least recently used first. */
  const live = new Map<string, { readonly prepared: PreparedRewrite; used: number }>()
  const handlers = {
    ...(yield* makeDisplayPrefsReadHandlers),
    ...(yield* makeExternalMediaReadHandlers),
    ...(yield* makeSavedMediaReadHandlers),
    ...(yield* makeSourcePrefsReadHandlers),
    ...(yield* makeCardOriginReadHandlers),
    ...(yield* makeTokenCountingReadHandlers),
    ...(yield* makeDecisionReadHandlers),
    ...(yield* makeAwayMarkReadHandlers),
    RoleProjections: () => assembler.projectionOptions,
    MergeLayouts: () => assembler.mergeLayoutOptions,
    ContextViews: () => assembler.contextViewOptions,
    AssembleContext: ({
      userId,
      chatId,
      slotId,
      versionId,
      forkId,
      now,
      timeZone,
      frozen,
      partialBatch,
      model,
      agent,
      decisions
    }) =>
      Effect.suspend(() => {
        const sources = sqlSources(sql, {
          userId,
          chatId,
          slotId,
          versionId,
          ...(partialBatch === undefined ? {} : { partialBatch }),
          ...(model === undefined ? {} : { modelOverride: model })
        })
        return assembler
          .assemble({
            now,
            timeZone,
            frozen: frozen ?? {},
            random: Math.random,
            ...(agent ? { agent } : {}),
            ...(decisions ? { decisions } : {})
          })
          .pipe(
            Effect.provide(sources.layer),
            Effect.flatMap(({ loreDecision, ...built }) =>
              Effect.gen(function* () {
                const snapshot: ContextSnapshot = {
                  ...built,
                  sources: sources.pins(),
                  ...(built.inputs.model ? { wire: wireContext(built.request, built.inputs.model) } : {})
                }
                const inspection = yield* inspectionInputs(sql, userId, snapshot, assembler)
                return {
                  snapshot: JSON.stringify(snapshot),
                  generation: JSON.stringify({ ...generationOf(snapshot), inspection }),
                  used: usedEntries(snapshot),
                  message: (snapshot.sources?.target.depth ?? 0) + 1,
                  ...(loreDecision ? { loreDecision } : {})
                }
              })
            )
          )
      }).pipe(readingOnce, inFork(sql, chatId, forkId, slotId), query("AssembleContext")),

    RebuildContext: ({ userId, snapshot: json }) =>
      Effect.gen(function* () {
        const stored = JSON.parse(json) as ContinuousSnapshot
        const taken = stored.continuity?.prefix ?? stored
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
            ...(taken.agentAssembly ? { agent: taken.agentAssembly } : {}),
            ...(taken.decisionAssembly ? { decisions: taken.decisionAssembly } : {}),
            ...(taken.summaryJob
              ? {
                  summarizing: true,
                  summaryClipTokens: taken.summaryJob.clipTokens,
                  summaryJob: taken.summaryAssembly?.job ?? taken.summaryJob,
                  ...(taken.summaryAssembly?.instruction
                    ? { summaryInstruction: taken.summaryAssembly.instruction }
                    : {}),
                  summarySamplers: taken.summaryAssembly?.samplers ?? taken.request.samplers
                }
              : {}),
            ...(taken.loreFallback ? { loreFallback: taken.loreFallback } : {})
          })
          .pipe(Effect.provide(sources.layer))
        const { loreDecision: _asked, ...assembled } = built
        const rebuilt = taken.summaryJob ? yield* fitSummaryOutput(assembled) : assembled
        return {
          _tag: "Rebuilt" as const,
          snapshot: JSON.stringify({
            ...rebuilt,
            ...(stored.continuity?.prefix ? { ...stored, request: rebuilt.request } : {}),
            // Earlier snapshots predate frozen transform inputs; retain their original shape.
            ...(!taken.summaryAssembly && rebuilt.summaryAssembly ? { summaryAssembly: undefined } : {}),
            sources: sources.pins(),
            ...(taken.wire ? { wire: taken.wire } : {})
          })
        }
      }).pipe(query("RebuildContext")),

    // The cache-warmth estimate (DESIGN §5.5): the chat's last request that reached its
    // provider and the next request's TTL eligibility and prefix at the end of the active path
    // compared up to its last breakpoint. Null when there's nothing to estimate.
    CacheWarmth: ({ userId, chatId, leafSlotId, forkId }) =>
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
            -- A decision model's request (the scene check, say) is no chat request: its snapshot has
            -- no request messages or breakpoints, and it warms no cache the next reply reads.
            JOIN rollouts r ON r.id = q.rollout_id AND r.kind <> 'decision'
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
        const leaf = historyLeafOf(sources.pins().target)
        const recorded =
          next instanceof AssemblyFailed
            ? yield* previousStartIn(
                sql,
                userId,
                chatId,
                leaf,
                yield* displayThrough(sql, chatId, yield* viewAt(sql, chatId, leaf), leaf)
              )
            : undefined
        const fallback = recorded
          ? { slotId: recorded.slot_id, depth: recorded.depth }
          : (sources.pins().historyStart ?? null)
        const start = next instanceof AssemblyFailed ? fallback : (next.historyStart ?? fallback)
        const resolved = sources.resolvedModel()
        const estimate = yield* estimateOf(sql, userId, assembler, next, sources)
        const nextFork = (yield* viewAt(sql, chatId, sources.pins().target.parentSlotId)) as ForkId | null
        // Composer uploads already belong to a server-backed, owner/fork-scoped draft.
        // Estimate them before Send with the same registered rules and stored facts as history.
        const draftImages = yield* sql<RequestImage>`SELECT m.id AS mediaId, m.sha256, m.width, m.height
          FROM drafts d JOIN composer_images i ON i.draft_id=d.id JOIN media_assets m ON m.id=i.media_id
          WHERE d.user_id=${userId} AND d.target_kind='composer' AND d.target_id=${chatId}
            AND d.field=${nextFork ?? ""} AND i.status='active' ORDER BY i.rowid`
        let imagePreview = next instanceof AssemblyFailed ? {} : nextImages(next)
        if (resolved && draftImages.length) {
          const facts = yield* readImageTokenFacts(
            sql,
            userId,
            { connectionId: resolved.connectionId, kind: resolved.kind, modelKey: resolved.key },
            draftImages.flatMap((image) => (image.sha256 ? [image.sha256] : []))
          )
          const target = { kind: resolved.kind, api: resolved.api, model: resolved.key }
          const history = next instanceof AssemblyFailed ? [] : next.request.messages
          let remaining = resolved.maxImages ?? 4
          const messages = [
            ...history,
            {
              role: "user" as const,
              content: "",
              images: draftImages.map((image) => ({
                ...image,
                estimate: estimateImage(image, target, assembler.imageTokens.list(), facts)
              }))
            }
          ]
            .toReversed()
            .map((message) => ({
              ...message,
              images: (message.images ?? [])
                .toReversed()
                .map((image) => ({
                  ...image,
                  estimate: {
                    ...(image.estimate ?? { tokens: null, basis: "unknown" as const }),
                    ...(image.estimate?.sent === false || resolved.vision === false || remaining-- <= 0
                      ? { sent: false as const }
                      : {})
                  }
                }))
                .reverse()
            }))
            .reverse()
          // The regular snapshot stays unchanged: these images are still drafts.
          imagePreview = nextImages({ request: { messages }, inputs: { model: resolved } })
        }
        const boundary = {
          ...estimate,
          forkId: nextFork,
          leafSlotId: sources.pins().target.parentSlotId,
          historyStart: start ? { slotId: start.slotId, depth: start.depth } : null,
          summarizedThrough: (sources.pins().lcm?.cursorDepth ?? -1) < 0 ? null : sources.pins().lcm!.cursorDepth,
          // The next request's images, and those whose model hasn't counted them (for ImageTokenCounts).
          ...imagePreview,
          ...(next instanceof AssemblyFailed || !next.imagesLeftOut ? {} : { images: next.imagesLeftOut })
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
        const previousCount = yield* prepareTextTokens(assembler.textCounters.list(), previous.inputs.model)
        const nextCount = yield* prepareTextTokens(assembler.textCounters.list(), next.inputs.model)
        const prefixTokens = tokensBetween(previous, 0, end, previousCount)
        const speakerCost = sameModel ? speakerPrefixChange(previous, next, nextCount) : null
        let speakerChange: string | undefined
        if (speakerCost) {
          const revisions = [previous, next].flatMap((s) =>
            s.inputs.cards.filter((c) => c.entity === s.inputs.speaker).map((c) => c.revision)
          )
          const rows = yield* sql<{
            id: string
            name: string
            nickname: string | null
          }>`SELECT v.id, json_extract(v.doc_json, '$.name') AS name, json_extract(v.doc_json, '$.nickname') AS nickname
            FROM entity_revisions v JOIN entities e ON e.id = v.entity_id WHERE e.owner_user_id = ${userId} AND v.id IN ${sql.in(revisions)}`
          const name = (s: ContextSnapshot) => {
            const revision = s.inputs.cards.find((c) => c.entity === s.inputs.speaker)?.revision
            const found = rows.find((r) => r.id === revision)
            return found ? modelName({ name: found.name, nickname: found.nickname ?? undefined }) : "A character"
          }
          const upcoming = name(next),
            preceding = name(previous)
          speakerChange = `${upcoming}'s turn starts differently from ${preceding}'s: ~${speakerCost.tokens.toLocaleString("en-US")} tokens are written again when ${upcoming}'s cached copy has expired.`
        }
        const speakerWarning = speakerChange === undefined ? {} : { speakerChange }

        // A prefix below the model's minimum cacheable size is never cached (liveapi F6).
        // The provider's documented contract; a snapshot from before providers names only its kind.
        const contract = next.inputs.model.cacheContract
        const target = {
          provider: contract === undefined ? next.inputs.model.kind : (contract ?? ""),
          api: next.inputs.model.api,
          model: next.inputs.model.key
        }
        const minimum = next.inputs.model.cacheLayout?.minTokens ?? documentedCacheMinimum(target)
        const nextEnd = lastBreakpoint(next)
        const nextTokens = nextEnd < 0 ? 0 : tokensBetween(next, 0, nextEnd, nextCount)
        if (minimum !== null && end >= 0 && prefixTokens < minimum) {
          return {
            ...boundary,
            warmth:
              nextTokens < minimum
                ? speakerChange === undefined
                  ? null
                  : {
                      lastRequestAt: last.started_at,
                      ttlS: null,
                      expiresAt: null,
                      verified: false,
                      prefixTokens: 0,
                      changed: null,
                      ...speakerWarning
                    }
                : {
                    lastRequestAt: last.started_at,
                    ttlS,
                    expiresAt: null,
                    verified: false,
                    prefixTokens: 0,
                    ...speakerWarning,
                    changed: {
                      reason: `The last request was below the model's minimum cacheable size (${minimum.toLocaleString("en-US")} tokens), so nothing was cached.`,
                      tokens: nextTokens
                    }
                  }
          }
        }
        // OpenAI's automatic cache, measured live (livefix, 2026-11-07): an edited prompt read none of
        // its unchanged start, a follow-up seconds later read nothing, and later requests read what an
        // earlier one did, not the whole previous prompt. So a change re-sends everything, and the
        // estimate claims only what the last request read (nothing before the first read).
        const bestEffort = bestEffortCache(target)
        const compared = prefixChange(
          previous,
          next,
          yield* describer(sql, userId, chatId, [previous, next], assembler),
          nextCount
        )
        const changed =
          compared && bestEffort ? { ...compared, tokens: Math.max(compared.tokens, nextTokens) } : compared
        const lastRead = last.cache_read ?? 0
        const reusable = bestEffort ? Math.min(prefixTokens, lastRead) : prefixTokens
        const expiresAt = yield* cacheExpiry(sql, userId, chatId, last, previous)
        return {
          ...boundary,
          warmth:
            (ttlS === null || expiresAt === null) && changed === null && speakerChange === undefined
              ? null
              : {
                  lastRequestAt: last.started_at,
                  ttlS,
                  expiresAt,
                  verified: (last.cache_read ?? 0) + (last.cache_write ?? 0) > 0,
                  prefixTokens: reusable,
                  ...speakerWarning,
                  changed
                }
        }
      }).pipe(inFork(sql, chatId, forkId, leafSlotId ?? null), query("CacheWarmth"), (effect) =>
        withAssemblyModules(assembler, effect)
      ),

    NextContextAccess: ({ userId, chatId, leafSlotId, forkId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: string }>`
          SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        if (leafSlotId != null) {
          const [slot] = yield* sql<{
            id: string
          }>`SELECT id FROM slots WHERE id = ${leafSlotId} AND chat_id = ${chatId}`
          if (!slot) return yield* new NotFound({ entity: "slot", id: leafSlotId })
        }
        if (forkId != null) {
          const [fork] = yield* sql<{ id: string }>`SELECT id FROM forks WHERE id = ${forkId} AND chat_id = ${chatId}`
          if (!fork) return yield* new NotFound({ entity: "fork", id: forkId })
        }
      }).pipe(query("NextContextAccess")),

    // A chat not made yet: the request its first send would make (DESIGN §2.1), from the same
    // pipeline over sources standing in for what StartChat would write. Nothing is written, and
    // this worker has no network: counts are the local tokenizers' (`textDisplay` refuses any).
    AssembleDraftChat: ({ userId, cards, persona, greeters, first, replier, remote, now }) =>
      Effect.gen(function* () {
        const sources = yield* draftSources(sql, {
          userId,
          cards,
          persona,
          greeters,
          first,
          replier,
          remote,
          now
        })
        // No model, no request: nothing is built (the first send would refuse before building).
        // A model that's gone says so, as the send would.
        const chosen = yield* sources.model().pipe(Effect.catchTag("AssemblyFailed", (error) => Effect.succeed(error)))
        if (chosen instanceof AssemblyFailed)
          return {
            ...(yield* estimateOf(sql, userId, assembler, chosen, sources)),
            warmth: null,
            leafSlotId: null,
            historyStart: null,
            summarizedThrough: null,
            request: null
          }
        if (chosen === null)
          return {
            model: null,
            warmth: null,
            leafSlotId: null,
            historyStart: null,
            summarizedThrough: null,
            request: null
          }
        const built = yield* assembler.assemble({ now, timeZone: "UTC", frozen: {}, random: Math.random }).pipe(
          Effect.provide(sources.layer),
          Effect.map((snapshot): ContextSnapshot => snapshot),
          Effect.catchTag("AssemblyFailed", (error) => Effect.succeed(error))
        )
        const estimate = yield* estimateOf(sql, userId, assembler, built, sources)
        const base = {
          ...estimate,
          warmth: null,
          leafSlotId: null,
          historyStart: null,
          summarizedThrough: null,
          ...(built instanceof AssemblyFailed ? {} : nextImages(built)),
          ...(built instanceof AssemblyFailed || !built.imagesLeftOut ? {} : { images: built.imagesLeftOut })
        }
        const model = built instanceof AssemblyFailed ? null : built.inputs.model
        if (built instanceof AssemblyFailed || model === null) return { ...base, request: null }
        // The request mapped for the model's API, as the inspector shows a sent one; message
        // sources lead nowhere, since the chat's messages don't exist yet.
        const inspection = yield* inspectionInputs(sql, userId, built, assembler)
        const wire = inspectWire(wireContext(built.request, model), built.request, inspection, (text) => text)
        const counts = yield* textDisplay(
          sql,
          userId,
          model,
          assembler,
          wire.messages.map((m) => m.content + (m.name ?? "")),
          now
        )
        const unlinked = (source: ContextSource): ContextSource => ({ ...source, slotId: null })
        return {
          ...base,
          request: {
            builtAt: now,
            type: built.inputs.type,
            mode: built.inputs.mode,
            tokenizer: counts.tokenizer,
            messages: contextMessages(wire, wireImages(wire.messages, built.request), counts.counts, unlinked),
            samplers: { ...wire.samplers },
            ...wire.display!,
            ...(wire.display?.notSent ? { notSent: wire.display.notSent.map(unlinked) } : {})
          }
        }
      }).pipe(query("AssembleDraftChat"), (effect) => withAssemblyModules(assembler, effect)),

    GetGenerationDefaults: ({ userId }) => readDefaults(sql, userId).pipe(query("GetGenerationDefaults")),
    LorebookPresets: ({ userId, ref }) => readLorebookPresets(sql, userId, ref).pipe(query("LorebookPresets")),
    GetGlobalRegex: ({ userId }) => readGlobalRegex(sql, userId).pipe(query("GetGlobalRegex")),

    RawVersionText: ({ userId, versionId }) =>
      sql<{ raw_content: string | null; raw_reasoning: string | null; raw_sections: string | null }>`
        SELECT v.raw_content, v.raw_reasoning, v.raw_sections FROM version_records v
        JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
        WHERE v.id = ${versionId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL
          AND v.deleted_at IS NULL AND v.purged_at IS NULL`.pipe(
        Effect.flatMap(([row]) =>
          row
            ? Effect.succeed({
                content: row.raw_content,
                reasoning: row.raw_reasoning,
                sections: row.raw_sections === null ? null : (JSON.parse(row.raw_sections) as ReplySections)
              })
            : Effect.fail(new NotFound({ entity: "version", id: versionId }))
        ),
        query("RawVersionText")
      ),

    // A generating reply's text so far, through the scripts its finish runs (ARCHITECTURE §12,
    // "Live rewrites"). The stages run once per reply in each worker; later calls only run them.
    RewriteLive: ({ userId, chatId, forkId, slotId, versionId, items }) =>
      Effect.gen(function* () {
        const key = `${userId}:${versionId}`
        const now = Date.now()
        for (const [k, entry] of live) if (now - entry.used > LIVE_IDLE_MS) live.delete(k)
        let entry = live.get(key)
        if (entry === undefined) {
          const [version] = yield* sql<{ speaker_entity_id: string | null; writer: "human" | "model" }>`
            SELECT v.speaker_entity_id, v.writer FROM versions v
            JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
            WHERE v.id = ${versionId} AND s.id = ${slotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId}`
          if (!version) return yield* new NotFound({ entity: "version", id: versionId })
          const sources = sqlSources(sql, { userId, chatId, slotId, versionId })
          const prepared = yield* assembler
            .prepareRewrite(
              { now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random },
              { edit: false, speaker: version.speaker_entity_id, writer: version.writer }
            )
            .pipe(Effect.provide(sources.layer), inFork(sql, chatId, forkId, slotId))
          entry = { prepared, used: now }
          if (live.size >= LIVE_MAX) live.delete(live.keys().next().value!)
          live.set(key, entry)
        } else {
          // Most recently used last, so the oldest goes first.
          live.delete(key)
          live.set(key, entry)
          entry.used = now
        }
        if (!entry.prepared.active) return { active: false, texts: [], ms: 0 }
        const start = performance.now()
        const texts = entry.prepared.run(items)
        return { active: true, texts, ms: performance.now() - start }
      }).pipe(query("RewriteLive")),

    // Text being written, through the scripts at its position (ARCHITECTURE §12, "Rewrites").
    RewriteText: ({ userId, chatId, forkId, at, edit, items }) =>
      Effect.gen(function* () {
        const existing = "versionId" in at
        const [version] = existing
          ? yield* sql<{ speaker_entity_id: string | null; writer: "human" | "model" }>`
              SELECT v.speaker_entity_id, v.writer FROM versions v
              JOIN slots s ON s.id = v.slot_id JOIN chats c ON c.id = s.chat_id
              WHERE v.id = ${at.versionId} AND s.id = ${at.slotId} AND c.id = ${chatId} AND c.owner_user_id = ${userId}`
          : []
        if (existing && !version) return yield* new NotFound({ entity: "version", id: at.versionId })
        const sources = existing
          ? sqlSources(sql, { userId, chatId, slotId: at.slotId, versionId: at.versionId })
          : sqlSources(sql, { userId, chatId, next: true, leafSlotId: at.leafSlotId })
        const options = existing
          ? { edit, speaker: version!.speaker_entity_id, writer: version!.writer }
          : { edit, speaker: at.speakerEntityId, writer: "human" as const }
        return yield* assembler
          .rewrite({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random }, options, items)
          .pipe(Effect.provide(sources.layer))
      }).pipe(inFork(sql, chatId, forkId, "versionId" in at ? at.slotId : at.leafSlotId), query("RewriteText")),
    GetCardPromptUse: ({ userId }) => readCardPromptUse(sql, userId).pipe(query("GetCardPromptUse"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
  return handlers
})
