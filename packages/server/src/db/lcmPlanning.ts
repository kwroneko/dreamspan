import { inJobFork } from "./lcmFork.ts"
import { viewAt } from "./forkState.ts"
import { MAX_CHUNK_SLOTS } from "./lcmLimits.ts"
import type { SummaryPrefix } from "../lcm/prefix.ts"
import { inFork } from "./forkState.ts"
import { completedCoverage, failedHold } from "./lcmCoverage.ts"
import { maintain, MAX_JOBS_PER_PLAN } from "./lcmMaintain.ts"
import { fitSummaryOutput } from "../lcm/requestBudget.ts"
import { foldState } from "@rp/shared/state.ts"
import { BUILTIN_SUMMARY_INSTRUCTION, chunkSize, resolveLcm } from "@rp/shared/lcmSettings.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { AssemblySources } from "../assembler/pipeline.ts"
import { WorkerAssembler } from "../assembler/assembler.ts"
import { AssemblyFailed, generationOf, type ContextSnapshot } from "../assembler/types.ts"
import { wireContext } from "../assembler/wire.ts"
import { sqlSources } from "./assemblySources.ts"
import { readDefaults } from "./generationSettings.ts"
import { backfillOf, overCap, spentSince } from "./lcmBackfill.ts"
import { jobColumns, type SummaryJob } from "./lcmJobs.ts"
import { lcmPath, slotInput } from "./lcmPath.ts"
import { readSummary } from "./lcmReads.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { selectSummaryLayer } from "./lcmLayer.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"
import { inspectionInputs } from "./inspectorReads.ts"

export const makeLcmPlanningHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* WorkerAssembler
  return {
    PlanSummaries: ({ userId, chatId, leafSlotId, forkId, reason }) =>
      Effect.gen(function* () {
        yield* lcmPath(sql, userId, chatId, leafSlotId, leafSlotId)
        const sources = sqlSources(sql, { userId, chatId, next: true, cut: leafSlotId })
        const events = yield* Effect.flatMap(AssemblySources, (s) => s.events(leafSlotId)).pipe(
          Effect.provide(sources.layer)
        )
        const state = foldState(events.map((e) => e.event))
        const defaults = yield* readDefaults(sql, userId)
        const fork = yield* viewAt(sql, chatId, leafSlotId)
        const jobs = yield* sql.unsafe<SummaryJob>(
          `SELECT ${jobColumns} FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id WHERE j.chat_id = ? AND c.owner_user_id = ? AND (j.fork_id IS NULL OR j.fork_id = ?) AND j.status IN ('pending','processing') ORDER BY j.created_at,j.id`,
          [chatId, userId, fork]
        )
        const empty = {
          chunks: [],
          refresh: [],
          condensations: [],
          flagged: [],
          enabled: state.lcm?.enabled === true,
          over: false,
          partialBatch: false,
          windowMax: 0,
          jobs: [],
          // "When it runs" (DESIGN §8): the chat's, else the account default's.
          spendAhead: resolveLcm(state.lcm, defaults.lcm).when !== "next-reply",
          blocked: null as "no_model" | null,
          liveJobs: 0,
          backfill: null as { armed: boolean; held: boolean; drive: boolean; settled: boolean } | null
        }
        if (!state.lcm?.enabled) return empty
        // The chat's backfill (spec/LCM.md §2.11): begun by a reply, held at its cap.
        const row = yield* backfillOf(sql, chatId)
        const live = row?.status === "processing" ? row : null
        const stopped = live
          ? live.paused || live.capped || overCap(live, yield* spentSince(sql, chatId, live.startedAt, live.forkId))
          : false
        const progress = live ? { armed: live.armed, held: stopped, drive: live.drive } : null
        // Enabling waits for the next reply; startup and a finished job's pass do not begin it.
        if (progress?.armed && reason !== "reply") return { ...empty, backfill: { ...progress, settled: false } }
        // Nothing is planned without a model to summarize with: jobs would only fail. The state is the caller's to show.
        const bound =
          state.modelBindings["summarizer"] ?? state.modelBindings["narrator"] ?? state.modelBindings[""] ?? null
        const usable = yield* Effect.flatMap(AssemblySources, (s) => s.model(bound)).pipe(
          Effect.provide(sources.layer),
          Effect.catchTag("AssemblyFailed", () => Effect.succeed(null))
        )
        if (usable === null)
          return { ...empty, blocked: "no_model" as const, backfill: progress && { ...progress, settled: false } }
        const layer = yield* selectSummaryLayer(sql, userId, chatId, leafSlotId)
        const path = yield* lcmPath(sql, userId, chatId, leafSlotId, layer.cursor ?? undefined)
        const onPath = new Set(path.map((s) => s.id))
        const active = jobs.filter((j) => onPath.has(j.lastSlotId))
        const built = yield* assembler
          .assemble({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random })
          .pipe(Effect.provide(sources.layer))
        // Recent messages kept as written (DESIGN §8): their pair as the assembly fitted it to the
        // history allowance. Planning starts at the midpoint, so summaries are usually ready before
        // the maximum, and keeps the target.
        const recent = built.lcm?.recentBudget ?? { target: 0, maximum: 0 }
        const windowMax = recent.maximum
        const leafInput = chunkSize(resolveLcm(state.lcm, defaults.lcm).leafInput, recent)
        // A chunk that doesn't fit twice in the band plans nothing: the Summaries section says so
        // under the chunk size, and it's the user's setting, not a failure.
        if (leafInput < 1 || leafInput * 2 > recent.maximum - recent.target) return empty
        const maintenance = reason
          ? yield* maintain(sql, userId, chatId, leafSlotId, layer, {
              reason,
              fanout: state.lcm.fanout,
              condenseTarget: state.lcm.condenseTarget,
              leafTarget: resolveLcm(state.lcm, defaults.lcm).leafTarget,
              clipTokens: Math.max(1, Math.floor(leafInput * 1.5)),
              budget: built.lcm?.layerBudget ?? { target: Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }
            })
          : { condensations: [], refresh: [], flagged: [] }
        const raw = path.filter((s) => s.depth > layer.cursorDepth)
        const cost = (s: (typeof path)[number]) => (s.content ? Math.ceil(s.content.length / 4) + 3 : 0)
        const total = raw.reduce((n, s) => n + cost(s), 0)
        const partialBatch = total > windowMax
        const available = partialBatch ? yield* selectSummaryLayer(sql, userId, chatId, leafSlotId, true) : layer
        const remaining = path.filter((s) => s.depth > available.cursorDepth)
        const settled = (r: {
          chunks: ReadonlyArray<unknown>
          refresh: ReadonlyArray<unknown>
          condensations: ReadonlyArray<unknown>
        }) =>
          progress && {
            ...progress,
            settled: active.length === 0 && !r.chunks.length && !r.refresh.length && !r.condensations.length
          }
        const result = {
          ...empty,
          ...maintenance,
          liveJobs: active.length,
          windowMax,
          partialBatch,
          over: remaining.reduce((n, s) => n + cost(s), 0) > windowMax,
          jobs: active.filter((j) => j.firstSlotId === remaining[0]?.id)
        }
        if (active.length || total <= (recent.target + recent.maximum) / 2)
          return { ...result, backfill: settled(result) }
        let keep = 0,
          end = raw.length
        while (end > 0 && keep < recent.target) keep += cost(raw[--end]!)
        // A failed summary holds its range while its inputs are unchanged (spec/LCM.md §2.8).
        const held = yield* failedHold(sql, userId, chatId, path)
        const chunks: Array<{ inputs: ReturnType<typeof slotInput>[]; target: number; clipTokens: number }> = []
        let chunk: (typeof path)[number][] = [],
          tokens = 0
        const covered = yield* completedCoverage(sql, userId, chatId, path)
        const flush = () => {
          if (chunk.length)
            chunks.push({
              inputs: chunk.map(slotInput),
              target: resolveLcm(state.lcm, defaults.lcm).leafTarget,
              clipTokens: Math.max(1, Math.floor(leafInput * 1.5))
            })
          chunk = []
          tokens = 0
        }
        for (const s of raw.slice(0, end)) {
          // A bounded batch: the rest is planned once this one has run (a write must stay short).
          if (chunks.length >= MAX_JOBS_PER_PLAN) break
          if (covered.has(s.id) || held.has(s.id)) {
            flush()
            continue
          }
          if (s.generating || s.merged) break
          chunk.push(s)
          tokens += cost(s)
          if (chunk.length >= MAX_CHUNK_SLOTS || tokens >= leafInput || (s.children >= 2 && tokens >= leafInput / 4)) {
            flush()
          }
        }
        if (chunks.length < MAX_JOBS_PER_PLAN) flush()
        return { ...result, chunks, backfill: settled({ ...result, chunks }) }
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("PlanSummaries")),
    AssembleSummary: ({ userId, jobId, attempt }) =>
      Effect.gen(function* () {
        const [job] = yield* sql.unsafe<SummaryJob>(
          `SELECT ${jobColumns} FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id WHERE j.id = ? AND c.owner_user_id = ? AND c.deleted_at IS NULL AND j.status = 'processing' AND j.claim_epoch = ?`,
          [jobId, userId, attempt]
        )
        if (!job) return yield* new NotFound({ entity: "summary job", id: jobId })
        const chain = yield* lcmPath(sql, userId, job.chatId, job.lastSlotId, job.firstSlotId)
        if (chain[0]?.id !== job.firstSlotId || chain.some((s) => s.generating || s.merged))
          return yield* new AssemblyFailed({
            reason: "invalid_document",
            message: "The summary job does not cover a ready primary-parent chain."
          })
        // A condensation is addressed by its parts: exactly these, at their selected revisions, in order.
        const children: Array<Summary> = []
        if (job.level > 1) {
          const [declared] = yield* sql<{ input_child_ids: string | null }>`
            SELECT input_child_ids FROM summarization_jobs WHERE id = ${jobId}`
          for (const id of JSON.parse(declared?.input_child_ids ?? "[]") as Array<string>)
            children.push(
              yield* readSummary(sql, userId, id).pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.fail(
                    new AssemblyFailed({ reason: "invalid_document", message: "A part of the condensation is gone." })
                  )
                )
              )
            )
          let at = 0
          for (const child of children) {
            if (child.status === "failed" || child.firstSlotId !== chain[at]?.id)
              return yield* new AssemblyFailed({
                reason: "invalid_document",
                message: "The condensation's parts do not follow the job's chain."
              })
            at += child.slotCount
          }
          if (children.length < 2 || at !== chain.length || children.at(-1)!.lastSlotId !== job.lastSlotId)
            return yield* new AssemblyFailed({
              reason: "invalid_document",
              message: "The condensation's parts do not cover the job's chain."
            })
        }
        const sources = sqlSources(sql, {
          userId,
          chatId: job.chatId,
          next: true,
          cut: job.lastSlotId,
          summaryBefore: { slot: chain[0]!.parent, depth: chain[0]!.depth - 1 },
          partialBatch: true,
          ...(job.level > 1
            ? { condense: { children, cursor: job.lastSlotId, cursorDepth: chain.at(-1)!.depth } }
            : {}),
          ...(job.modelJson
            ? { modelOverride: JSON.parse(job.modelJson) as { connection: string; model: string } }
            : {})
        })
        const events = yield* Effect.flatMap(AssemblySources, (s) => s.events(job.lastSlotId)).pipe(
          Effect.provide(sources.layer)
        )
        const state = foldState(events.map((e) => e.event)),
          defaults = yield* readDefaults(sql, userId)
        if (!state.lcm?.enabled)
          return yield* new AssemblyFailed({ reason: "invalid_document", message: "LCM is disabled." })
        const [pinned] = yield* sql<{
          prefix_json: string | null
        }>`SELECT prefix_json FROM summarization_jobs WHERE id=${jobId}`
        const prefix = pinned?.prefix_json ? (JSON.parse(pinned.prefix_json) as SummaryPrefix) : undefined
        const style = state.lcm.style ?? "direct"
        const settings = resolveLcm(state.lcm, defaults.lcm)
        const clipTokens = job.clipTokens
        const built = yield* assembler
          .assemble({
            now: prefix?.inputs.now ?? Date.now(),
            timeZone: prefix?.inputs.timeZone ?? "UTC",
            frozen: prefix?.frozen ?? {},
            random: Math.random,
            summarizing: true,
            summaryClipTokens: clipTokens,
            summaryInstruction: {
              target: job.target,
              ...(children.length ? { range: { from: children[0]!.from, to: children.at(-1)!.to } } : {})
            },
            summaryJob: {
              id: jobId,
              clipTokens,
              inputs: job.level > 1 ? [] : chain.map(slotInput),
              ...(job.level > 1
                ? { children: children.map((c) => ({ summaryId: c.id, revisionId: c.revisionId })) }
                : {}),
              tail: settings.tail ?? BUILTIN_SUMMARY_INSTRUCTION,
              style,
              ...(settings.withPreset ? {} : { withPreset: false }),
              ...(prefix ? { prefix } : {})
            }
          })
          .pipe(Effect.provide(sources.layer))
        const rendered = new Set(
          built.pieces
            .filter((p) => p.source.kind === "message" && p.messages.length > 0)
            .map((p) => (p.source.kind === "message" ? p.source.version : ""))
        )
        const sent = built.lcm?.selected.slice(-children.length || undefined) ?? []
        if (
          job.level === 1
            ? chain.some((s) => s.versionId && !rendered.has(s.versionId))
            : sent.length !== children.length ||
              sent.some((s, n) => s.id !== children[n]!.id || s.revision !== children[n]!.revisionId)
        )
          return yield* new AssemblyFailed({
            reason: "budget",
            message:
              job.level === 1
                ? "The summary request cannot render its whole declared chunk."
                : "The condensation request cannot render exactly its declared parts."
          })
        if (built.lcm?.omitted.length)
          return yield* new AssemblyFailed({
            reason: "budget",
            message: "The summary request cannot render its whole declared chunk."
          })
        const snapshot: ContextSnapshot = { ...built, sources: sources.pins() }
        const taken = yield* fitSummaryOutput(snapshot)
        const wire = taken.inputs.model ? wireContext(taken.request, taken.inputs.model) : undefined
        return {
          snapshot: JSON.stringify({ ...taken, ...(wire ? { wire } : {}) }),
          generation: JSON.stringify({
            ...generationOf(taken),
            inspection: yield* inspectionInputs(sql, userId, taken)
          })
        }
      }).pipe(inJobFork(sql, jobId), query("AssembleSummary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
