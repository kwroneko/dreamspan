// The real generator: assembly, rollout, provider stream (ARCHITECTURE §15, "Generation").
import { uuidv7 } from "@rp/shared/id.ts"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import type { Generation } from "../assembler/types.ts"
import { providerRequest } from "../assembler/wire.ts"
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
          const assembled = yield* reader
            .AssembleContext({ userId, chatId, slotId, versionId, now: Date.now(), timeZone: "UTC", frozen: null })
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
          const wire = providerRequest(generation.request, model)
          return providers
            .stream({
              userId,
              connectionId: model.connectionId as ConnectionId,
              modelId: model.modelId as ModelId,
              context: wire.context,
              inspection: { request: generation.request, model },
              options: {
                ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
                ...(wire.maxTokens !== undefined ? { maxTokens: wire.maxTokens } : {}),
                sessionId: chatId,
                payload: wire.payload,
                breakpoints: wire.breakpoints
              },
              attribution: { purpose: "generation", chatId, rolloutId, versionId }
            })
            .pipe(
              Stream.filter((event) => event.type === "text"),
              Stream.map((event) => event.delta),
              Stream.mapError((error) =>
                error._tag === "ProviderError"
                  ? new GenerationFailed({ class: error.reason, message: error.message })
                  : new GenerationFailed({ class: "server", message: error.message })
              )
            )
        })
      )

    return Option.some({ generate })
  })
)
