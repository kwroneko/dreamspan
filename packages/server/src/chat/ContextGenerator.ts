import { AppConfig } from "../config.ts"
import { hydrateMessageImages } from "./messageImages.ts"
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
import { throughParse } from "./replySections.ts"
import { ChatHub } from "./ChatHub.ts"
import { foldState } from "@rp/shared/state.ts"
import { PLAIN_MODE, planTurn } from "../agent/modes.ts"
import { frozenTool } from "../agent/tools.ts"

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
    const config = yield* AppConfig
    const hub = yield* ChatHub

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
          // The chat's mode at this point decides who runs and how (spec/AGENTIC.md §6).
          const events = yield* reader
            .StateEventsAt({ userId, chatId, slotId: parent, forkId })
            .pipe(Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("StateEventsAt")))
          const planned = planTurn(execution.orchestrationModes, foldState(events))
          if ("unavailable" in planned)
            return yield* new GenerationFailed({
              class: "unavailable",
              message: `The reply mode “${planned.unavailable}” is unavailable.`
            })
          const { plan } = planned
          const agentic = plan.strategy !== "reply"
          const tools = plan.tools.flatMap((id) => {
            const tool = execution.rolloutTools.get(id)
            // Tools with effects outside the chat are never offered in an RP turn (DESIGN §7.3).
            return tool && tool.effect !== "external" ? [tool] : []
          })
          const assemble = reader
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
              ...(request.model ? { model: request.model } : {}),
              ...(plan.assembly
                ? {
                    agent: {
                      instructions: plan.assembly.instructions(
                        tools.map((t) => t.id),
                        plan.contract
                      ),
                      cardsAtTail: plan.assembly.cardsAtTail
                    }
                  }
                : {})
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
          let assembled = yield* assemble
          // Live text is what's sent (owner, 2026-11-01): what the assembly read and has changed
          // since its last revision gets a revision labelled with this reply, and the reply is
          // assembled again from it. A new revision can bring in another entry (a note's link),
          // so a few rounds, each only when something was cut.
          for (let round = 0; round < 3; round++) {
            const { cut } = yield* writer
              .CheckpointLiveText({
                userId,
                chatId,
                forkId,
                slotId,
                versionId,
                leafSlotId: (JSON.parse(assembled.generation) as Generation).leafSlotId as SlotId | null,
                message: assembled.message,
                used: assembled.used
              })
              .pipe(
                Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("CheckpointLiveText"))
              )
            if (cut === 0) break
            hub.publish(chatId, { _tag: "State" })
            assembled = yield* assemble
          }
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
              // An agent turn's tools and contract are frozen with its context (spec/AGENTIC.md §3.3).
              snapshot: agentic
                ? `${assembled.snapshot.trimEnd().slice(0, -1)},"agent":${JSON.stringify({
                    mode: planned.mode,
                    contract: plan.contract,
                    turnCap: plan.turnCap,
                    tools: tools.map(frozenTool)
                  })}}`
                : assembled.snapshot,
              ...(planned.mode === PLAIN_MODE ? {} : { mode: planned.mode }),
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
          const strategy = execution.replyStrategies.get(plan.strategy)
          if (!strategy)
            return yield* new GenerationFailed({ class: "unavailable", message: "Reply strategy is unavailable." })
          const reply = strategy.run({
            request,
            generation,
            rolloutId,
            output,
            providers,
            ...(agentic ? { agent: { plan, mode: planned.mode, tools, reader, writer } } : {}),
            resolveImages: (input) =>
              hydrateMessageImages(input, model, (id) => reader.GetMediaFile({ userId, mediaId: id }), config.dataDir)
          })
          // The registered reply parsers, in order: the leading tagged sections (replySections.ts).
          return execution.replyParsers
            .list()
            .flatMap((parser) => {
              const parse = parser.create({ request, generation })
              return parse ? [{ parse, fresh: () => parser.create({ request, generation })! }] : []
            })
            .reduce((stream, { parse, fresh }) => throughParse(stream, parse, fresh), reply)
        })
      )

    return Option.some({ generate })
  })
)
