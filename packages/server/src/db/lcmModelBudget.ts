// Retention belongs to the reply window; a different summary model bounds only the chunks.
// These are local worker assemblies. Neither measurement starts a provider request.
import { Effect, type Layer } from "effect"
import type { SqlClient } from "effect/sql"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { ASSUMED_CONTEXT } from "@dreamspan/shared/modelSettings.ts"
import { BUILTIN_SUMMARY_INSTRUCTION, type ResolvedLcm } from "@dreamspan/shared/lcmSettings.ts"
import { WORKSHOP_SUMMARY_INSTRUCTION } from "@dreamspan/shared/workshopLcm.ts"
import type { Assembler } from "../assembler/assembler.ts"
import { AssemblySources } from "../assembler/pipeline.ts"
import { AssemblyFailed, type ContextSnapshot, type ModelInput } from "../assembler/types.ts"
import { tokensOf } from "../assembler/st.ts"

export const planningContext = Effect.fnUntraced(function* (
  assembler: Assembler,
  layer: Layer.Layer<AssemblySources>,
  fallback: ModelInput
) {
  return yield* Effect.gen(function* () {
    const base = yield* AssemblySources
    return yield* assembler.assemble({ now: Date.now(), timeZone: "UTC", frozen: {}, random: Math.random }).pipe(
      Effect.provideService(AssemblySources, {
        ...base,
        model: (binding) =>
          base.model(binding).pipe(
            Effect.map((model) => model ?? fallback),
            Effect.catchTag("AssemblyFailed", (error) =>
              error.reason === "no_model" ? Effect.succeed(fallback) : Effect.fail(error)
            )
          )
      })
    )
  }).pipe(Effect.provide(layer))
})

export const summaryChunkRoom = Effect.fnUntraced(function* ({
  sql,
  assembler,
  layer,
  model,
  reply,
  settings,
  chatId
}: {
  sql: SqlClient.SqlClient
  assembler: Assembler
  layer: Layer.Layer<AssemblySources>
  model: ModelInput
  reply: ContextSnapshot
  settings: ResolvedLcm
  chatId: string
}) {
  // Keep the established path and cost for chats using their reply model for summaries.
  if (model.modelId === reply.inputs.model?.modelId) return Infinity
  const [chat] = yield* sql<{ kind: string }>`SELECT kind FROM chats WHERE id=${chatId}`
  const workshop = chatKinds.get(chat?.kind ?? "")?.summaryTranscript === true
  const selector = assembler.summaryStyles.get("settings")
  if (!selector)
    return yield* new AssemblyFailed({ reason: "invalid_document", message: "Summary style selection is unavailable." })
  const budget = yield* Effect.gen(function* () {
    const base = yield* AssemblySources
    return yield* assembler
      .assemble({
        now: reply.inputs.now,
        timeZone: reply.inputs.timeZone,
        frozen: {},
        random: Math.random,
        summarizing: true,
        summaryInstruction: { target: settings.leafTarget },
        summaryJob: {
          id: "planning",
          inputs: [],
          clipTokens: 1,
          tail: settings.tail ?? (workshop ? WORKSHOP_SUMMARY_INSTRUCTION : BUILTIN_SUMMARY_INSTRUCTION),
          style: selector.select(settings.style),
          ...(settings.withPreset === "raw" || workshop ? { withPreset: false } : {}),
          ...(workshop ? { workshopTranscript: [] } : {})
        }
      })
      .pipe(
        Effect.provideService(AssemblySources, {
          ...base,
          model: () => Effect.succeed(model),
          history: () => Effect.succeed({ entries: [], older: null }),
          historyStart: () => Effect.succeed(null),
          historyRevision: () => Effect.succeed(0),
          messageCount: () => Effect.succeed(0)
        })
      )
  }).pipe(Effect.provide(layer))
  const room =
    (budget.lcm?.measure?.context ?? model.context ?? ASSUMED_CONTEXT) -
    budget.request.messages.reduce((n, message) => n + tokensOf(message), 0) -
    budget.request.samplers.max_tokens
  // Oversized individual messages can be clipped at 1.5 times the planned input size.
  return Math.max(0, Math.floor(room / 1.5))
})
