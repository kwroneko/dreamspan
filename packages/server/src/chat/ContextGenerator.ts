import { executionRegistry } from "../execution.ts"
import { Summarizer } from "../lcm/Summarizer.ts"
// The real generator: assembly, rollout, provider stream (ARCHITECTURE §15, "Generation").
import { uuidv7 } from "@rp/shared/id.ts"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import type { Generation } from "../assembler/types.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Providers } from "../providers/Providers.ts"
import { GenerationFailed, type GenerationRequest, Generator } from "./Generator.ts"

/** What a failed storage or worker call says on the version: the details stay in the log. */
const serverFailure = (operation: string) => (error: unknown) =>
  Effect.logError(`${operation} failed`, error).pipe(
    Effect.andThen(
      Effect.fail(new GenerationFailed({ class: "server", message: "The server couldn't prepare the request." }))
    )
  )

export const layer = Layer.effect(
  Generator,
  Effect.gen(function* () {
    const execution = yield* executionRegistry
    const summaries = yield* Summarizer
    const reader = yield* Reader
    const writer = yield* Writer
    const providers = yield* Providers

    // Rollouts a previous process left running ended with it; their versions were
    // interrupted the same way (Generations).
    const { interrupted } = yield* writer.InterruptRollouts()
    if (interrupted > 0) yield* Effect.logWarning(`${interrupted} rollouts were interrupted by the last shutdown`)

    const generate = (request: GenerationRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { userId, chatId, slotId, versionId } = request
          // Read in the fork it was started in: the chat's current fork may be another by now.
          const forkId = request.forkId ?? null
          const slot = yield* reader
            .GetSlot({ userId, slotId, forkId })
            .pipe(Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("GetSlot")))
          const parent = slot.entry.parentSlotId
          const partialBatch = parent
            ? yield* summaries.beforeReply({
                userId,
                chatId,
                leafSlotId: parent,
                ...(forkId === null ? {} : { forkId })
              })
            : false
          const assembled = yield* reader
            .AssembleContext({
              userId,
              chatId,
              slotId,
              versionId,
              forkId,
              now: Date.now(),
              timeZone: "UTC",
              frozen: null,
              partialBatch,
              ...(request.model ? { model: request.model } : {})
            })
            .pipe(
              Effect.catchTag("AssemblyFailed", (error) =>
                Effect.fail(new GenerationFailed({ class: error.reason, message: error.message }))
              ),
              Effect.catchTag("NotFound", () =>
                Effect.fail(
                  new GenerationFailed({ class: "not_found", message: "The message being generated is gone." })
                )
              ),
              Effect.catchTag(["StorageError", "RpcClientError"], serverFailure("AssembleContext"))
            )
          const generation = JSON.parse(assembled.generation) as Generation
          const { model } = generation
          if (model === null) {
            return yield* new GenerationFailed({
              class: "no_model",
              message: "No model is chosen: bind one to this chat, or choose a default model."
            })
          }
          const rolloutId = uuidv7()
          const finish = (exit: Exit.Exit<unknown, unknown>) =>
            writer
              .FinishRollout({
                userId,
                rolloutId,
                versionId,
                status: Exit.isSuccess(exit) ? "completed" : Cause.hasInterruptsOnly(exit.cause) ? "stopped" : "failed",
                error: Exit.isFailure(exit)
                  ? Option.getOrNull(
                      Option.map(Cause.findErrorOption(exit.cause), (e) =>
                        e instanceof GenerationFailed ? e.message : String(e)
                      )
                    )
                  : null
              })
              .pipe(Effect.catch((error) => Effect.logError(`closing rollout ${rolloutId} failed`, error)))
          // Opened and closed as a resource of the stream's scope: once it's open, it's closed
          // whenever and however the generation ends, a stop before the first token included.
          yield* Effect.acquireRelease(
            writer.StartRollout({
              userId,
              chatId,
              slotId,
              versionId,
              rolloutId,
              leafSlotId: generation.leafSlotId as SlotId | null,
              forkId,
              connectionId: model.connectionId as ConnectionId,
              modelId: model.modelId as ModelId,
              snapshot: assembled.snapshot,
              issues: generation.issues,
              variables: generation.variables,
              frozenMessages: generation.frozenMessages.map((m) => ({ ...m, versionId: m.versionId as VersionId }))
            }),
            (_, exit) => finish(exit)
          ).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.fail(new GenerationFailed({ class: "not_found", message: "The model or the message is gone." }))
            ),
            Effect.catchTag(["StorageError", "RpcClientError"], serverFailure("StartRollout"))
          )
          const outputStrategy = execution.replies.get("reply")
          if (!outputStrategy)
            return yield* new GenerationFailed({
              class: "unavailable",
              message: "Reply output strategy is unavailable."
            })
          const output = outputStrategy.create({
            prefix: model.prefill === "tool_schema" ? generation.request.prefill : null,
            request,
            generation,
            rolloutId
          })
          const strategy = execution.replyStrategies.get("reply")
          if (!strategy)
            return yield* new GenerationFailed({ class: "unavailable", message: "Reply strategy is unavailable." })
          return strategy.run({ request, generation, rolloutId, output, providers })
        })
      )

    return Option.some({ generate })
  })
)
