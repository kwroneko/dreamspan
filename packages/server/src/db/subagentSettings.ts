// Subagents' models and limits (spec/SUBAGENTS.md §5, §6.2): the account's settings
// (`subagents.models`, `subagents.limits` in the settings table), a chat's list at a position
// (its own picks where the subagent model chip is locked, else the account's), and what a
// subagent and its run have spent, from the ledger. Owner-scoped; the reads run in the reader
// worker, the write in the writer's one transaction.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { requestInputTokens } from "./requestInput.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { resolveLcm } from "@dreamspan/shared/lcmSettings.ts"
import { supportedEfforts, type ReasoningEffort } from "@dreamspan/shared/modelSettings.ts"
import { resolveModel } from "@dreamspan/shared/providers.ts"
import {
  parseModelPick,
  resolveLimits,
  resolveModels,
  rowProblems,
  rowsFor,
  SAME,
  SUMMARY,
  SubagentSettingsRejected,
  type SubagentCaps,
  type ResolvedLimits,
  type SubagentLimits,
  type SubagentModelRow,
  type SubagentModels,
  type SubagentTypes
} from "@dreamspan/shared/subagents.ts"
import { AssemblySources } from "../assembler/pipeline.ts"
import { resolveSummaryModel } from "../assembler/summaryModel.ts"
import type { ModelInput } from "../assembler/types.ts"
import { sqlSources } from "./assemblySources.ts"
import { inFork } from "./forkState.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { toModel, type ModelRow } from "./providers.ts"
import { putUserSetting, readSetting } from "./settings.ts"
import { replySubagents, spendOf } from "./subagents.ts"
import { query, transaction } from "./tx.ts"

const MODELS_KEY = "subagents.models"
const LIMITS_KEY = "subagents.limits"
const TYPES_KEY = "subagents.types"

/** A decision connection answers decisions only, never a reply or a subagent (DESIGN §7.6). */
const DECISION_KIND = "system-one"

/** One model a chat's subagents may use, as the runner and the `agent` tool read it. */
export interface SubagentModelEntry {
  readonly pick: string
  readonly alias: string
  readonly note: string
  readonly caps?: SubagentCaps
  /** The row's reasoning level (§5.1), where set. */
  readonly effort?: ReasoningEffort
  /** The levels its model takes (`supportedEfforts`); empty where it doesn't reason. */
  readonly efforts: ReadonlyArray<ReasoningEffort>
  /** The model's key, as the assistant reads it beside the alias. */
  readonly name: string
  /** Absent for `same`: the run's own model. */
  readonly model?: ModelInput
}

export interface SubagentModelsAt {
  readonly entries: ReadonlyArray<SubagentModelEntry>
  readonly limits: ResolvedLimits
  /** The user's subagent types and changes (§10), as stored. */
  readonly types: SubagentTypes
}

const stored = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.all([
    readSetting(sql, "user", userId, MODELS_KEY),
    readSetting(sql, "user", userId, LIMITS_KEY),
    readSetting(sql, "user", userId, TYPES_KEY)
  ]).pipe(
    Effect.map(([models, limits, types]) => ({
      models: resolveModels(models.value as SubagentModels | null),
      limits: (limits.value as SubagentLimits | null) ?? {},
      types: Array.isArray(types.value) ? (types.value as SubagentTypes) : []
    }))
  )

/** A model by binding, or null where it's gone (a deleted connection or model). */
const modelOf = (
  base: AssemblySources["Service"],
  binding: { readonly connection: string; readonly model: string } | null
) =>
  base
    .model(binding)
    .pipe(
      Effect.catchTag("AssemblyFailed", (error) =>
        error.reason === "no_model" ? Effect.succeed(null) : Effect.fail(error)
      )
    )

/** The reasoning levels a model takes, from its own capabilities (what the model settings show). */
const effortsOf = (sql: SqlClient.SqlClient, model: ModelInput) =>
  Effect.map(
    sql<ModelRow>`SELECT * FROM models WHERE id = ${model.modelId} AND connection_id = ${model.connectionId}`,
    ([row]): ReadonlyArray<ReasoningEffort> => {
      if (!row) return []
      const m = toModel(row)
      return supportedEfforts(resolveModel(m.key, m.upstream, m.overrides))
    }
  )

const sameModel = (a: ModelInput, b: ModelInput) => a.connectionId === b.connectionId && a.modelId === b.modelId

export const makeSubagentSettingReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SubagentSettings: ({ userId }) => stored(sql, userId).pipe(query("SubagentSettings")),

    SubagentModelsAt: ({ userId, chatId, forkId, leafSlotId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: string }>`
          SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const { models, limits, types } = yield* stored(sql, userId)
        const sources = sqlSources(sql, { userId, chatId, next: true, leafSlotId })
        const base = yield* Effect.map(AssemblySources, (s) => s).pipe(Effect.provide(sources.layer))
        const state = foldState((yield* base.events(leafSlotId)).map((e) => e.event))
        // The chat's lock, else the account's picks: as the model chip's lock (§5.1a [D]).
        const picks = state.subagentModels ?? models.picks
        const rows = rowsFor(models, picks)
        const chatModel = yield* modelOf(base, state.modelBindings[""] ?? null)
        const listed: Array<ModelInput> = chatModel ? [chatModel] : []
        const entries: Array<SubagentModelEntry> = []
        const entry = (
          pick: string,
          row: SubagentModelRow,
          name: string,
          efforts: ReadonlyArray<ReasoningEffort>,
          model?: ModelInput
        ): SubagentModelEntry => ({
          pick,
          alias: row.alias,
          note: row.note,
          name,
          ...(row.caps ? { caps: row.caps } : {}),
          ...(row.effort ? { effort: row.effort } : {}),
          efforts,
          ...(model ? { model } : {})
        })
        if (picks.includes(SAME) && chatModel)
          entries.push(
            entry(SAME, { ...rows.get(SAME)!, alias: "same" }, chatModel.key, yield* effortsOf(sql, chatModel))
          )
        // `summary` is the chat's summary model only where this chat summarizes (§5.1): there it
        // already sends to it. Elsewhere the pick, made in another chat, names nothing, so it never
        // sends a chat's content to a connection that chat didn't choose.
        const summarizes = () =>
          Effect.map(
            base.lcmDefaults ? base.lcmDefaults() : Effect.succeed(null),
            (account) => resolveLcm(state.lcm, account).enabled
          )
        for (const pick of picks) {
          if (pick === SAME) continue
          const model =
            pick === SUMMARY
              ? (yield* summarizes())
                ? (yield* resolveSummaryModel(base, state.modelBindings)).model
                : null
              : yield* modelOf(base, parseModelPick(pick))
          // Gone, a decision connection, or already listed (the chat's own model is `same`).
          if (!model || model.kind === DECISION_KIND || listed.some((m) => sameModel(m, model))) continue
          listed.push(model)
          entries.push(entry(pick, rows.get(pick)!, model.key, yield* effortsOf(sql, model), model))
        }
        const at: SubagentModelsAt = { entries, limits: resolveLimits(limits), types }
        return JSON.stringify(at)
      }).pipe(inFork(sql, chatId, forkId, leafSlotId), query("SubagentModelsAt")),

    SubagentSpend: ({ userId, rolloutId }) =>
      Effect.gen(function* () {
        const [child] = yield* sql<{ spawned_by_rollout_id: string | null }>`
          SELECT r.spawned_by_rollout_id FROM rollouts r JOIN chats c ON c.id = r.chat_id
          WHERE r.id = ${rolloutId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
        if (!child?.spawned_by_rollout_id) return yield* new NotFound({ entity: "subagent", id: rolloutId })
        const [own] = yield* sql<{ requests: number; tokens: number | null; cost: number | null; unpriced: number }>`
          SELECT count(*) AS requests,
            sum(${requestInputTokens(sql)} + coalesce(output, 0)) AS tokens,
            sum(cost) AS cost, sum(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced
          FROM llm_requests WHERE rollout_id = ${rolloutId} AND status <> 'running'`
        // The reply's subagents together, across its Stops and Resumes (§6.2).
        const reply = yield* replySubagents(sql, child.spawned_by_rollout_id)
        const run = yield* spendOf(
          sql,
          reply.map((r) => r.id),
          true
        )
        return {
          requests: own?.requests ?? 0,
          tokens: own?.tokens ?? 0,
          cost: own?.cost ?? 0,
          unpriced: own?.unpriced ?? 0,
          runCost: run.cost,
          runUnpriced: run.unpriced
        }
      }).pipe(query("SubagentSpend"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

/** `same` keeps its name; the summary model's and the others' are the user's. */
const normalized = (rows: Readonly<Record<string, SubagentModelRow>>) =>
  Object.fromEntries(Object.entries(rows).map(([pick, row]) => [pick, pick === SAME ? { ...row, alias: "same" } : row]))

export const makeSubagentSettingWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ChangeSubagentSettings: ({ userId, picks, rows, limits, types }) =>
      Effect.gen(function* () {
        if (picks !== undefined || rows !== undefined) {
          const current = (yield* readSetting(sql, "user", userId, MODELS_KEY)).value as SubagentModels | null
          const next = {
            picks: picks ?? current?.picks ?? resolveModels(null).picks,
            rows: normalized({ ...current?.rows, ...rows })
          } satisfies SubagentModels
          if (rows !== undefined) {
            const problems = rowProblems(resolveModels(next).rows)
            if (problems.length > 0) return yield* new SubagentSettingsRejected({ message: problems.join(" ") })
          }
          yield* putUserSetting(sql, userId as UserId, MODELS_KEY, next)
        }
        if (limits !== undefined) yield* putUserSetting(sql, userId as UserId, LIMITS_KEY, limits ?? {})
        if (types !== undefined) yield* putUserSetting(sql, userId as UserId, TYPES_KEY, types)
      }).pipe(transaction(sql, "ChangeSubagentSettings"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
