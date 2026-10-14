import { Summarizer } from "../lcm/Summarizer.ts"
// The real generator: assembly, rollout, provider stream (ARCHITECTURE §15, "Generation").
import { uuidv7 } from "@rp/shared/id.ts"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Cause, Effect, Exit, Layer, Option, Result, Schema, Stream } from "effect"
import type { Generation } from "../assembler/types.ts"
import { REPLY_TOOL } from "../assembler/prefill.ts"
import { providerRequest } from "../assembler/wire.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Providers } from "../providers/Providers.ts"
import { GenerationFailed, type GenerationChunk, type GenerationRequest, Generator } from "./Generator.ts"

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
          const slot = yield* reader
            .GetSlot({ userId, slotId })
            .pipe(Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("GetSlot")))
          const parent = slot.entry.parentSlotId
          const partialBatch = parent ? yield* summaries.beforeReply({ userId, chatId, leafSlotId: parent }) : false
          const assembled = yield* reader
            .AssembleContext({
              userId,
              chatId,
              slotId,
              versionId,
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
          const prefix = model.prefill === "tool_schema" ? generation.request.prefill : null
          let emitted = ""
          const decodeReply = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))
          const suffix = (args: unknown, final: boolean): Effect.Effect<string, GenerationFailed> => {
            const decoded = decodeReply(args)
            const text = Option.isSome(decoded) ? decoded.value.text : null
            if (text === null || !text.startsWith(prefix!)) {
              return final
                ? Effect.fail(
                    new GenerationFailed({
                      class: "bad_prefill",
                      message: "The provider did not return the required reply prefix."
                    })
                  )
                : Effect.succeed("")
            }
            const next = text.slice(prefix!.length)
            if (!next.startsWith(emitted))
              return Effect.fail(
                new GenerationFailed({ class: "bad_prefill", message: "The provider changed text already streamed." })
              )
            const delta = next.slice(emitted.length)
            emitted = next
            return Effect.succeed(delta)
          }
          return providers
            .stream({
              userId,
              connectionId: model.connectionId as ConnectionId,
              modelId: model.modelId as ModelId,
              context: wire.context,
              inspection: { request: generation.request, model, display: generation.inspection },
              options: {
                ...(prefix !== null ? { replyTool: REPLY_TOOL } : {}),
                ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
                ...(wire.maxTokens !== undefined ? { maxTokens: wire.maxTokens } : {}),
                sessionId: chatId,
                payload: wire.payload,
                breakpoints: wire.breakpoints
              },
              attribution: { purpose: "generation", chatId, rolloutId, versionId }
            })
            .pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "waiting-cache") request.onWaitingCache?.(event.waiting)
                })
              ),
              // Schema arguments are text only: no tool execution or tool loop. Strip the
              // constrained prefix as it streams, and validate the completed call too.
              Stream.mapEffect((event) => {
                if (event.type === "thinking")
                  return Effect.succeed(Result.succeed<GenerationChunk>({ reasoning: event.delta }))
                if (prefix !== null) {
                  if (event.type === "toolcall" && event.name === REPLY_TOOL)
                    return suffix(event.arguments, false).pipe(
                      Effect.map((delta) => (delta ? Result.succeed<GenerationChunk>(delta) : Result.failVoid))
                    )
                  if (event.type === "done") {
                    const calls = event.message.content.filter((block) => block.type === "toolCall")
                    if (calls.length !== 1 || calls[0]!.name !== REPLY_TOOL)
                      return Effect.fail(
                        new GenerationFailed({
                          class: "bad_prefill",
                          message: "The provider did not return the required reply tool."
                        })
                      )
                    let args: unknown
                    try {
                      args = JSON.parse(event.toolArguments[calls[0]!.id] ?? "")
                    } catch {
                      return Effect.fail(
                        new GenerationFailed({
                          class: "bad_prefill",
                          message: "The provider returned malformed reply tool JSON."
                        })
                      )
                    }
                    return suffix(args, true).pipe(
                      Effect.map((delta) => (delta ? Result.succeed<GenerationChunk>(delta) : Result.failVoid))
                    )
                  }
                  return Effect.succeed(Result.failVoid)
                }
                return Effect.succeed(
                  event.type === "text" ? Result.succeed<GenerationChunk>(event.delta) : Result.failVoid
                )
              }),
              Stream.filterMap((chunk) => chunk),
              Stream.mapError((error) =>
                error._tag === "GenerationFailed"
                  ? error
                  : error._tag === "ProviderError"
                    ? new GenerationFailed({ class: error.reason, message: error.message })
                    : new GenerationFailed({ class: "server", message: error.message })
              )
            )
        })
      )

    return Option.some({ generate })
  })
)
