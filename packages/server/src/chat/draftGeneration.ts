// A draft is one plain provider turn, scoped to its RPC stream. Cancellation closes the
// ledger/rollout through the same provider and FinishRollout paths as a reply.
import type { DraftGenerationTarget } from "@rp/shared/generationTarget.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { ServerError } from "@rp/shared/errors.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Cause, Effect, Exit, Option, Stream } from "effect"
import { makeRegistry } from "../registry.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Providers } from "../providers/Providers.ts"
import { AppConfig } from "../config.ts"
import type { Generation } from "../assembler/types.ts"
import { hydrateMessageImages } from "./messageImages.ts"
import { replyDecoder } from "./replyOutput.ts"
import { runPlainReply } from "./replyStrategy.ts"
import { throughParse } from "./replySections.ts"
import { ExecutionRegistry } from "../execution.ts"
import { internal } from "../api/internal.ts"

type DraftServices = {
  readonly execution: ExecutionRegistry["Service"]
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly providers: Providers["Service"]
  readonly config: import("../config.ts").AppConfigShape
}

export const makeDraftGeneration = Effect.gen(function* () {
  const execution = yield* ExecutionRegistry
  const reader = yield* Reader
  const writer = yield* Writer
  const providers = yield* Providers
  const config = yield* AppConfig
  return (userId: UserId, target: DraftGenerationTarget) => {
    const part = draftGenerationParts.get("draft")
    return part
      ? part.run({ execution, reader, writer, providers, config }, userId, target)
      : Stream.fail(new ServerError({ message: "Write for me is unavailable." }))
  }
})

const plainDraft = (
  { execution, reader, writer, providers, config }: DraftServices,
  userId: UserId,
  target: DraftGenerationTarget
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const assembled = yield* reader.AssembleDraftTurn({ userId, target, now: Date.now(), timeZone: "UTC" })
      const generation = JSON.parse(assembled.generation) as Generation
      const model = generation.model
      if (!model) return yield* new ServerError({ message: "Choose a model for this chat first." })
      const rolloutId = uuidv7()
      yield* Effect.acquireRelease(
        writer.StartDraftRollout({
          userId,
          target,
          rolloutId,
          connectionId: model.connectionId as ConnectionId,
          modelId: model.modelId as ModelId,
          snapshot: assembled.snapshot,
          issues: generation.issues
        }),
        (_, exit) =>
          writer
            .FinishRollout({
              userId,
              rolloutId,
              versionId: null,
              status: Exit.isSuccess(exit) ? "completed" : Cause.hasInterruptsOnly(exit.cause) ? "stopped" : "failed",
              error: Exit.isFailure(exit)
                ? Option.getOrNull(Option.map(Cause.findErrorOption(exit.cause), String))
                : null
            })
            .pipe(Effect.catch((error) => Effect.logError("Closing the draft request failed", error)))
      )
      const reply = runPlainReply({
        request: { userId, chatId: target.chatId },
        target,
        generation,
        rolloutId,
        output: replyDecoder(model.prefill === "tool_schema" ? generation.request.prefill : null),
        providers,
        resolveImages: (input) =>
          hydrateMessageImages(input, model, (id) => reader.GetMediaFile({ userId, mediaId: id }), config.dataDir)
      })
      const parsed = execution.replyParsers
        .list()
        .flatMap((parser) => {
          const parse = parser.create({ request: {}, generation })
          return parse ? [parse] : []
        })
        .reduce((stream, parse) => throughParse(stream, parse), reply)
      return Stream.concat(
        Stream.make({ rolloutId, text: "" }),
        parsed.pipe(
          Stream.filter((chunk): chunk is string => typeof chunk === "string"),
          Stream.map((text) => ({ rolloutId, text }))
        )
      )
    }).pipe(
      Effect.catchTag("AssemblyFailed", (e) => Effect.fail(new ServerError({ message: e.message }))),
      Effect.catchTag("StaleWrite", () =>
        Effect.fail(new ServerError({ message: "The branch changed. Try again here." }))
      ),
      internal("WriteForMe")
    )
  ).pipe(Stream.mapError((e) => (e._tag === "GenerationFailed" ? new ServerError({ message: e.message }) : e)))

export const draftGenerationParts = makeRegistry([{ id: "draft", source: import.meta.url, run: plainDraft }])
