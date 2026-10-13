import { applySummaryPrefix, type SummaryPrefix } from "../lcm/prefix.ts"
import { completedCoverage } from "./lcmCoverage.ts"
import { tokensOf } from "../assembler/st.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { AssemblySources } from "../assembler/pipeline.ts"
import { makeAssembler } from "../assembler/assembler.ts"
import { AssemblyFailed, generationOf, type ContextSnapshot } from "../assembler/types.ts"
import { wireContext } from "../assembler/wire.ts"
import { summaryTail } from "../lcm/request.ts"
import { sqlSources } from "./assemblySources.ts"
import { readDefaults } from "./generationSettings.ts"
import { jobColumns, type SummaryJob } from "./lcmJobs.ts"
import { lcmPath, slotInput } from "./lcmPath.ts"
import { selectSummaryLayer } from "./lcmLayer.ts"
import { NotFound, type ReadOps } from "./ops.ts"
import { query } from "./tx.ts"
import { inspectionInputs } from "./inspectorReads.ts"

export const makeLcmPlanningHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const assembler = yield* makeAssembler
  return {
    PlanSummaries: ({ userId, chatId, leafSlotId }) =>
      Effect.gen(function* () {
        yield* lcmPath(sql, userId, chatId, leafSlotId, leafSlotId)
        const sources = sqlSources(sql, { userId, chatId, next: true, cut: leafSlotId })
        const events = yield* Effect.flatMap(AssemblySources, (s) => s.events(leafSlotId)).pipe(
          Effect.provide(sources.layer)
        )
        const state = foldState(events.map((e) => e.event))
        const defaults = yield* readDefaults(sql, userId)
        const jobs = yield* sql.unsafe<SummaryJob>(
          `SELECT ${jobColumns} FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id WHERE j.chat_id = ? AND c.owner_user_id = ? AND j.status IN ('pending','processing') ORDER BY j.created_at,j.id`,
          [chatId, userId]
        )
        const empty = {
          chunks: [],
          enabled: state.lcm?.enabled === true,
          over: false,
          partialBatch: false,
          windowMax: 0,
          jobs: [],
          spendAhead: defaults.lcm?.spendAhead !== false
        }
        if (!state.lcm?.enabled) return empty
        const layer = yield* selectSummaryLayer(sql, userId, chatId, leafSlotId)
        const path = yield* lcmPath(sql, userId, chatId, leafSlotId, layer.cursor ?? undefined)
        const onPath = new Set(path.map((s) => s.id))
        const active = jobs.filter((j) => onPath.has(j.lastSlotId))
        const built = yield* assembler
          .assemble({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random })
          .pipe(Effect.provide(sources.layer))
        const windowMax = Math.max(0, Math.floor(built.historyBudget ?? 0))
        const leafInput = state.lcm.leafInput ?? Math.min(4000, Math.floor(windowMax / 8))
        if (leafInput < 1 || leafInput * 2 > windowMax / 4)
          return yield* new AssemblyFailed({
            reason: "budget",
            message: "LCM's runway must fit two summary chunks; increase the context or reduce leafInput."
          })
        const raw = path.filter((s) => s.depth > layer.cursorDepth)
        const cost = (s: (typeof path)[number]) => (s.content ? Math.ceil(s.content.length / 4) + 3 : 0)
        const total = raw.reduce((n, s) => n + cost(s), 0)
        const partialBatch = total > windowMax
        const available = partialBatch ? yield* selectSummaryLayer(sql, userId, chatId, leafSlotId, true) : layer
        const remaining = path.filter((s) => s.depth > available.cursorDepth)
        const result = {
          ...empty,
          windowMax,
          partialBatch,
          over: remaining.reduce((n, s) => n + cost(s), 0) > windowMax,
          jobs: active.filter((j) => j.firstSlotId === remaining[0]?.id)
        }
        if (active.length || total <= windowMax * 0.75) return result
        let keep = 0,
          end = raw.length
        while (end > 0 && keep < windowMax * 0.5) keep += cost(raw[--end]!)
        const chunks: Array<{ inputs: ReturnType<typeof slotInput>[]; target: number; clipTokens: number }> = []
        let chunk: (typeof path)[number][] = [],
          tokens = 0
        const covered = yield* completedCoverage(sql, userId, chatId, path)
        const flush = () => {
          if (chunk.length)
            chunks.push({
              inputs: chunk.map(slotInput),
              target: state.lcm!.leafTarget ?? 600,
              clipTokens: Math.max(1, Math.floor(leafInput * 1.5))
            })
          chunk = []
          tokens = 0
        }
        for (const s of raw.slice(0, end)) {
          if (covered.has(s.id)) {
            flush()
            continue
          }
          if (s.generating || s.merged) break
          chunk.push(s)
          tokens += cost(s)
          if (tokens >= leafInput || (s.children >= 2 && tokens >= leafInput / 4)) {
            flush()
          }
        }
        flush()
        // A terminal failure holds its range until explicit retry (slice 4).
        const failed = yield* sql<{
          first_slot_id: string
          last_slot_id: string
        }>`SELECT first_slot_id,last_slot_id FROM summarization_jobs WHERE chat_id = ${chatId} AND status = 'failed' AND level = 1`
        return {
          ...result,
          chunks: chunks.filter(
            (c) =>
              !failed.some((f) => c.inputs.some((i) => i.slotId === f.first_slot_id || i.slotId === f.last_slot_id))
          )
        }
      }).pipe(query("PlanSummaries")),
    AssembleSummary: ({ userId, jobId, attempt }) =>
      Effect.gen(function* () {
        const [job] = yield* sql.unsafe<SummaryJob>(
          `SELECT ${jobColumns} FROM summarization_jobs j JOIN chats c ON c.id = j.chat_id WHERE j.id = ? AND c.owner_user_id = ? AND c.deleted_at IS NULL AND j.status = 'processing' AND j.claim_epoch = ?`,
          [jobId, userId, attempt]
        )
        if (!job) return yield* new NotFound({ entity: "summary job", id: jobId })
        const chain = yield* lcmPath(sql, userId, job.chatId, job.lastSlotId, job.firstSlotId)
        if (job.level !== 1 || chain[0]?.id !== job.firstSlotId || chain.some((s) => s.generating || s.merged))
          return yield* new AssemblyFailed({
            reason: "invalid_document",
            message: "The summary job does not cover a ready primary-parent chain."
          })
        const sources = sqlSources(sql, {
          userId,
          chatId: job.chatId,
          next: true,
          cut: job.lastSlotId,
          summaryBefore: { slot: chain[0]!.parent, depth: chain[0]!.depth - 1 },
          partialBatch: true
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
        const clipTokens = job.clipTokens
        const built = yield* assembler
          .assemble({
            now: prefix?.inputs.now ?? Date.now(),
            timeZone: prefix?.inputs.timeZone ?? "UTC",
            frozen: prefix?.frozen ?? {},
            random: Math.random,
            summarizing: true,
            summaryClipTokens: clipTokens
          })
          .pipe(Effect.provide(sources.layer))
        const rendered = new Set(
          built.pieces
            .filter((p) => p.source.kind === "message" && p.messages.length > 0)
            .map((p) => (p.source.kind === "message" ? p.source.version : ""))
        )
        if (chain.some((s) => s.versionId && !rendered.has(s.versionId)) || built.lcm?.omitted.length)
          return yield* new AssemblyFailed({
            reason: "budget",
            message: "The summary request cannot render its whole declared chunk."
          })
        const style = state.lcm.style ?? "direct"
        const tail =
          (state.lcm.tail ??
            defaults.lcm?.tail ??
            `Summarize the conversation since the previous summaries in at most ${job.target} words. Keep its language and voice, names, events and unresolved details. The preceding summaries are continuity, not material to summarize again.`) +
          (style === "tool"
            ? "\nWrite the summary with summary_tool. Create a draft and finalize it; assistant prose is not the summary."
            : "\nReturn only the summary, without commentary.")
        const snapshot: ContextSnapshot = summaryTail(
          applySummaryPrefix(
            {
              ...built,
              sources: sources.pins(),
              summaryJob: {
                id: jobId,
                clipTokens,
                inputs: chain.map(slotInput),
                tail,
                style,
                ...(prefix ? { prefix } : {})
              },
              request: {
                ...built.request,
                samplers: { ...built.request.samplers, max_tokens: Math.ceil(job.target * 2.5) }
              }
            },
            prefix
          )
        )
        const availableOutput = Math.floor(
          (snapshot.inputs.model?.context ?? Infinity) - snapshot.request.messages.reduce((n, m) => n + tokensOf(m), 0)
        )
        if (availableOutput < 1)
          return yield* new AssemblyFailed({
            reason: "budget",
            message: "The pinned summary prefix and chunk exceed the model context."
          })
        const taken = {
          ...snapshot,
          request: {
            ...snapshot.request,
            samplers: {
              ...snapshot.request.samplers,
              max_tokens: Math.min(snapshot.request.samplers.max_tokens, availableOutput)
            }
          }
        }
        const wire = taken.inputs.model ? wireContext(taken.request, taken.inputs.model) : undefined
        return {
          snapshot: JSON.stringify({ ...taken, ...(wire ? { wire } : {}) }),
          generation: JSON.stringify({
            ...generationOf(taken),
            inspection: yield* inspectionInputs(sql, userId, taken)
          })
        }
      }).pipe(query("AssembleSummary"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
