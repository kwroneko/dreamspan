import { Effect, Exit, Stream } from "effect"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import type { AssembledRequest, Generation } from "../assembler/types.ts"
import { providerRequest } from "../assembler/wire.ts"
import type { Providers } from "../providers/Providers.ts"
import { GenerationFailed, type GenerationRequest, type GenerationChunk } from "./Generator.ts"
import type { ReplyOutputStrategy } from "./replyOutput.ts"

export interface ReplyStrategy {
  readonly id: string
  readonly run: (input: {
    readonly resolveImages: (input: AssembledRequest) => Effect.Effect<AssembledRequest, GenerationFailed>
    readonly request: GenerationRequest
    readonly generation: Generation
    readonly rolloutId: string
    readonly purpose?: "generation" | "workshop"
    readonly output: ReturnType<ReplyOutputStrategy["create"]>
    readonly providers: Providers["Service"]
    /** An agent turn's plan, tools and storage (spec/AGENTIC.md §3); absent for a plain reply. */
    readonly agent?: import("../agent/session.ts").AgentRun
  }) => Stream.Stream<GenerationChunk, GenerationFailed>
}
/** The existing single provider turn, including streaming preference and output decoding. */
export const defaultReplyStrategy: ReplyStrategy = {
  id: "reply",
  run: ({ request, generation, rolloutId, output, providers, resolveImages, purpose }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { userId, chatId, versionId } = request
        const model = generation.model!
        const resolved = yield* resolveImages(generation.request)
        const wire = providerRequest(resolved, model)
        const showStreaming = model.settings?.stream !== false
        const chunks = providers
          .stream({
            userId,
            connectionId: model.connectionId as ConnectionId,
            modelId: model.modelId as ModelId,
            context: wire.context,
            inspection: { request: generation.request, model, display: generation.inspection },
            options: {
              ...(model.settings?.cacheRetention ? { cacheRetention: model.settings.cacheRetention } : {}),
              ...(request.outputBudget ? { outputBudget: request.outputBudget } : {}),
              ...(output.replyTool ? { replyTool: output.replyTool } : {}),
              ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
              ...(wire.maxTokens !== undefined ? { maxTokens: wire.maxTokens } : {}),
              ...(wire.reasoning ? { reasoning: wire.reasoning } : {}),
              sessionId: chatId,
              payload: wire.payload,
              breakpoints: wire.breakpoints,
              ...(wire.stable ? { stable: wire.stable } : {})
            },
            attribution: { purpose: purpose ?? "generation", chatId, rolloutId, versionId }
          })
          .pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type === "waiting-cache") request.onWaitingCache?.(event.waiting)
              })
            ),
            Stream.mapEffect(output.decode),
            Stream.filterMap((chunk) => chunk),
            Stream.mapError((error) =>
              error._tag === "GenerationFailed"
                ? error
                : error._tag === "ProviderError"
                  ? new GenerationFailed({
                      class: error.reason,
                      message: error.message,
                      ...(error.contextLimit === undefined
                        ? {}
                        : { contextLimit: { tokens: error.contextLimit, modelId: model.modelId } })
                    })
                  : new GenerationFailed({ class: "server", message: error.message })
            )
          )
        return showStreaming
          ? chunks
          : Stream.unwrap(
              Effect.gen(function* () {
                const buffered: Array<GenerationChunk> = []
                const exit = yield* Effect.exit(
                  Stream.runForEach(chunks, (chunk) =>
                    Effect.sync(() => {
                      buffered.push(chunk)
                    })
                  )
                )
                const text = Stream.fromIterable(buffered)
                return Exit.isFailure(exit) ? Stream.concat(text, Stream.failCause(exit.cause)) : text
              })
            )
      })
    )
}
