// Subagents' models and limits (spec/SUBAGENTS.md §5, §6.2): the account's settings
// (`subagents.models`, `subagents.limits` in the settings table), a chat's list at a position
// (its own picks where the subagent model chip is locked, else the account's), and what a
// subagent and its run have spent, from the ledger. Owner-scoped; the reads run in the reader
// worker, the write in the writer's one transaction.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import {
  parseModelPick,
  resolveLimits,
  resolveModels,
  rowsFor,
  SAME,
  SUMMARY,
  type SubagentCaps,
  type SubagentLimits,
  type SubagentModelRow,
  type SubagentModels
} from "@dreamspan/shared/subagents.ts"
import { AssemblySources } from "../assembler/pipeline.ts"
import { resolveSummaryModel } from "../assembler/summaryModel.ts"
import type { ModelInput } from "../assembler/types.ts"
import { sqlSources } from "./assemblySources.ts"
import { NotFound, type ReadOps, type WriteOps } from "./ops.ts"
import { putUserSetting, readSetting } from "./settings.ts"
import { query, transaction } from "./tx.ts"

const MODELS_KEY = "subagents.models"
const LIMITS_KEY = "subagents.limits"

/** A decision connection answers decisions only, never a reply or a subagent (DESIGN §7.6). */
const DECISION_KIND = "system-one"

/** One model a chat's subagents may use, as the runner and the `agent` tool read it. */
export interface SubagentModelEntry {
  readonly pick: string
  readonly alias: string
  readonly note: string
  readonly caps?: SubagentCaps
  /** The model's key, as the assistant reads it beside the alias. */
  readonly name: string
  /** Absent for `same`: the run's own model. */
  readonly model?: ModelInput
}

export interface SubagentModelsAt {
  readonly entries: ReadonlyArray<SubagentModelEntry>
  readonly limits: Required<SubagentLimits>
}

const stored = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.all([readSetting(sql, "user", userId, MODELS_KEY), readSetting(sql, "user", userId, LIMITS_KEY)]).pipe(
    Effect.map(([models, limits]) => ({
      models: resolveModels(models.value as SubagentModels | null),
      limits: (limits.value as SubagentLimits | null) ?? {}
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

const sameModel = (a: ModelInput, b: ModelInput) => a.connectionId === b.connectionId && a.modelId === b.modelId

export const makeSubagentSettingReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    SubagentSettings: ({ userId }) => stored(sql, userId).pipe(query("SubagentSettings")),

    SubagentModelsAt: ({ userId, chatId, leafSlotId }) =>
      Effect.gen(function* () {
        const [chat] = yield* sql<{ id: string }>`
          SELECT id FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId} AND deleted_at IS NULL`
        if (!chat) return yield* new NotFound({ entity: "chat", id: chatId })
        const { models, limits } = yield* stored(sql, userId)
        const sources = sqlSources(sql, { userId, chatId, next: true, leafSlotId })
        const base = yield* Effect.map(AssemblySources, (s) => s).pipe(Effect.provide(sources.layer))
        const state = foldState((yield* base.events(leafSlotId)).map((e) => e.event))
        // The chat's lock, else the account's picks: as the model chip's lock (§5.1a [D]).
        const picks = state.subagentModels ?? models.picks
        const rows = rowsFor(models, picks)
        const chatModel = yield* modelOf(base, state.modelBindings[""] ?? null)
        const listed: Array<ModelInput> = chatModel ? [chatModel] : []
        const entries: Array<SubagentModelEntry> = []
        const entry = (pick: string, row: SubagentModelRow, name: string, model?: ModelInput): SubagentModelEntry => ({
          pick,
          alias: row.alias,
          note: row.note,
          name,
          ...(row.caps ? { caps: row.caps } : {}),
          ...(model ? { model } : {})
        })
        if (picks.includes(SAME) && chatModel)
          entries.push(entry(SAME, { ...rows.get(SAME)!, alias: "same" }, chatModel.key))
        for (const pick of picks) {
          if (pick === SAME) continue
          const model =
            pick === SUMMARY
              ? (yield* resolveSummaryModel(base, state.modelBindings)).model
              : yield* modelOf(base, parseModelPick(pick))
          // Gone, a decision connection, or already listed (the chat's own model is `same`).
          if (!model || model.kind === DECISION_KIND || listed.some((m) => sameModel(m, model))) continue
          listed.push(model)
          entries.push(entry(pick, rows.get(pick)!, model.key, model))
        }
        const at: SubagentModelsAt = { entries, limits: resolveLimits(limits) }
        return JSON.stringify(at)
      }).pipe(query("SubagentModelsAt"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

/** `same` keeps its name; the summary model's and the others' are the user's. */
const normalized = (rows: Readonly<Record<string, SubagentModelRow>>) =>
  Object.fromEntries(Object.entries(rows).map(([pick, row]) => [pick, pick === SAME ? { ...row, alias: "same" } : row]))

export const makeSubagentSettingWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ChangeSubagentSettings: ({ userId, picks, rows, limits }) =>
      Effect.gen(function* () {
        if (picks !== undefined || rows !== undefined) {
          const current = (yield* readSetting(sql, "user", userId, MODELS_KEY)).value as SubagentModels | null
          yield* putUserSetting(sql, userId as UserId, MODELS_KEY, {
            picks: picks ?? current?.picks ?? resolveModels(null).picks,
            rows: normalized({ ...current?.rows, ...rows })
          } satisfies SubagentModels)
        }
        if (limits !== undefined) yield* putUserSetting(sql, userId as UserId, LIMITS_KEY, limits ?? {})
      }).pipe(transaction(sql, "ChangeSubagentSettings"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
