import type { GenerationTarget } from "@dreamspan/shared/generationTarget.ts"
import { Effect, Exit, Stream } from "effect"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import type { AssembledRequest, Generation } from "../assembler/types.ts"
import { providerRequest } from "../assembler/wire.ts"
import type { Providers } from "../providers/Providers.ts"
import { GenerationFailed, type GenerationRequest, type GenerationChunk } from "./Generator.ts"
import type { ReplyOutputStrategy } from "./replyOutput.ts"
import { requestDigest, type NativeReasoning } from "../assembler/reasoningReplay.ts"
import type { AssistantMessage } from "@earendil-works/pi-ai"

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
  run: (input) => runPlainReply({ ...input, target: { kind: "version", versionId: input.request.versionId } })
}

const runPlainReply = ({
  request,
  generation,
  rolloutId,
  output,
  providers,
  resolveImages,
  purpose,
  target
}: {
  readonly request: Pick<GenerationRequest, "userId" | "chatId" | "onWaitingCache" | "outputBudget" | "initial">
  readonly target: GenerationTarget
  readonly generation: Generation
  readonly rolloutId: string
  readonly output: ReturnType<ReplyOutputStrategy["create"]>
  readonly providers: Providers["Service"]
  readonly resolveImages: Parameters<ReplyStrategy["run"]>[0]["resolveImages"]
  readonly purpose?: "generation" | "workshop"
}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { userId, chatId } = request
      const model = generation.model!
      const resolved = yield* resolveImages(generation.request)
      const wire = providerRequest(resolved, model)
      const showStreaming = model.settings?.stream !== false
      // The reply's reasoning as the provider sent it, kept with the reply to send back later
      // (assembler/reasoningReplay.ts): only for a reply of its own, not a continuation or a prefill.
      let native: NativeReasoning | undefined
      const keep = (message: AssistantMessage & { readonly thinkingRecord?: unknown }) => {
        if (request.initial || generation.request.prefill || generation.request.continuation) return
        const parts = message.content.flatMap((part) =>
          part.type === "thinking"
            ? [
                {
                  text: part.thinking,
                  ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}),
                  ...(part.redacted ? { redacted: true } : {})
                }
              ]
            : []
        )
        if (parts.length === 0) return
        native = {
          api: model.api,
          kind: model.kind,
          key: model.key,
          connectionId: model.connectionId,
          modelId: model.modelId,
          ...(model.connectionRevision !== undefined ? { connectionRevision: model.connectionRevision } : {}),
          prefix: requestDigest(generation.request.messages),
          // Without the end-of-request message, which the history never repeats.
          ...(generation.request.endMessage ? { bare: requestDigest(generation.request.messages.slice(0, -1)) } : {}),
          parts,
          ...(message.providerThinkingLevel !== undefined ? { level: message.providerThinkingLevel } : {}),
          ...(message.thinkingRecord !== undefined ? { record: message.thinkingRecord } : {})
        }
      }
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
            ...(generation.request.replayReasoning ? { replayReasoning: true } : {}),
            ...(output.replyTool ? { replyTool: output.replyTool } : {}),
            ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
            ...(wire.maxTokens !== undefined ? { maxTokens: wire.maxTokens } : {}),
            ...(wire.reasoning ? { reasoning: wire.reasoning } : {}),
            sessionId: chatId,
            payload: wire.payload,
            breakpoints: wire.breakpoints,
            ...(wire.stable ? { stable: wire.stable } : {})
          },
          attribution: {
            purpose: purpose ?? "generation",
            chatId,
            rolloutId,
            versionId: target.versionId
          }
        })
        .pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "waiting-cache") request.onWaitingCache?.(event.waiting)
              if (event.type === "done") keep(event.message)
            })
          ),
          Stream.mapEffect(output.decode),
          Stream.filterMap((chunk) => chunk),
          Stream.concat(
            Stream.suspend(() =>
              native ? Stream.succeed<GenerationChunk>({ native: JSON.stringify(native) }) : Stream.empty
            )
          ),
          Stream.mapError((error) =>
            error._tag === "GenerationFailed"
              ? error
              : error._tag === "ProviderError"
                ? new GenerationFailed({
                    class: error.reason,
                    message: error.message,
                    ...(error.contextLimit === undefined
                      ? {}
                      : { contextLimit: { tokens: error.contextLimit, modelId: model.modelId } }),
                    ...(error.outputLimit === undefined
                      ? {}
                      : { outputLimit: { tokens: error.outputLimit, modelId: model.modelId } })
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
