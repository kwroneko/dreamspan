import { DEFAULT_MAX_IMAGES } from "../assembler/images.ts"
import { providerRequest } from "../assembler/wire.ts"
import { liveSuffix } from "../agent/messages.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  previousRun,
  readContinuityPath,
  pathStamp,
  summarizeMessageSteps,
  WORKSHOP_OVERFLOW_STEP_SUMMARIES,
  type ContinuousSnapshot,
  type ContinuityRecord
} from "../agent/continuity.ts"
import { AppConfig } from "../config.ts"
import { hydrateMessageImages } from "./messageImages.ts"
import { executionRegistry } from "../execution.ts"
import { Summarizer } from "../lcm/Summarizer.ts"
// The real generator: assembly, rollout, provider stream (ARCHITECTURE §15, "Generation").
import { uuidv7 } from "@rp/shared/id.ts"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import { type ContextSnapshot, type Generation, generationOf } from "../assembler/types.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Providers } from "../providers/Providers.ts"
import { GenerationFailed, type GenerationRequest, Generator } from "./Generator.ts"
import { throughParse } from "./replySections.ts"
import { ChatHub } from "./ChatHub.ts"
import { foldState } from "@rp/shared/state.ts"
import { planTurn } from "../agent/modes.ts"
import type { OutputContract } from "../agent/modes.ts"
import { type FrozenTool, frozenTool, sendMessageDefinition, severalMessageDefinition } from "../agent/tools.ts"
import { DecisionEngine } from "../decision/engine.ts"
import type { LoreAdmission, LoreInput } from "../decision/points/lore.ts"

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
    // Optional, as decision models are (DESIGN §7.6): without the engine the keywords decide.
    const decisions = yield* Effect.serviceOption(DecisionEngine)

    // Rollouts a previous process left running ended with it; their versions were
    // interrupted the same way (Generations).
    const { interrupted } = yield* writer.InterruptRollouts()
    if (interrupted > 0) yield* Effect.logWarning(`${interrupted} rollouts were interrupted by the last shutdown`)

    const finishing = (request: GenerationRequest, rolloutId: string) => (exit: Exit.Exit<unknown, unknown>) =>
      writer
        .FinishRollout({
          userId: request.userId,
          rolloutId,
          versionId: request.versionId,
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

    /** The registered reply parsers, in order, over a strategy's chunks (replySections.ts). */
    /**
     * A prefilled reply that ends with no text after the prefill isn't a reply (liveapi F12): it
     * fails, so the error shows and the reply can be retried, instead of saving an empty complete
     * version Continue then refuses. The same for every provider and prefill kind; a continuation
     * and an agent reply are left as they are.
     */
    const emptyAfterPrefill = (
      request: GenerationRequest,
      generation: Generation,
      agentic: boolean,
      reply: Stream.Stream<import("./Generator.ts").GenerationChunk, GenerationFailed>
    ) => {
      if (agentic || request.initial || !generation.request.prefill) return reply
      let text = false
      return reply.pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            const said =
              typeof chunk === "string" ? chunk : "text" in chunk ? chunk.text : "held" in chunk ? chunk.held : ""
            if (said.trim() !== "") text = true
          })
        ),
        Stream.concat(
          Stream.suspend(() =>
            text
              ? Stream.empty
              : Stream.fail(
                  new GenerationFailed({
                    class: "empty_reply",
                    message: "The model returned no text after the reply's prefill."
                  })
                )
          )
        )
      )
    }

    const parsed = (
      request: GenerationRequest,
      generation: Generation,
      reply: Stream.Stream<import("./Generator.ts").GenerationChunk, GenerationFailed>
    ) =>
      execution.replyParsers
        .list()
        .flatMap((parser) => {
          const parse = parser.create({ request, generation })
          return parse ? [{ parse, fresh: () => parser.create({ request, generation })! }] : []
        })
        .reduce((stream, { parse, fresh }) => throughParse(stream, parse, fresh), reply)

    /**
     * A resumed agent reply (spec/AGENTIC.md §4.2): no assembly. The stopped run's frozen
     * snapshot is the request, its frozen tools are what's offered, and its transcript goes on,
     * so every request is the one the stopped run would have sent.
     */
    const resumed = (request: GenerationRequest, resume: NonNullable<GenerationRequest["resume"]>) =>
      Effect.gen(function* () {
        const snapshot = JSON.parse(resume.snapshot) as ContextSnapshot & {
          readonly agent?: {
            readonly mode: string
            readonly contract: OutputContract
            readonly turnCap: number
            readonly tools: ReadonlyArray<FrozenTool>
            readonly inspection?: Generation["inspection"]
          }
        }
        const generation = {
          ...generationOf(snapshot),
          ...(snapshot.agent?.inspection ? { inspection: snapshot.agent.inspection } : {})
        }
        const { model } = generation
        const frozen = snapshot.agent
        if (model === null || frozen === undefined)
          return yield* new GenerationFailed({ class: "unavailable", message: "This reply can't be resumed." })
        const { rolloutId } = resume
        yield* Effect.addFinalizer(finishing(request, rolloutId))
        const outputStrategy = execution.replies.get("reply")
        const strategy = execution.replyStrategies.get("agent")
        if (!outputStrategy || !strategy)
          return yield* new GenerationFailed({ class: "unavailable", message: "Reply strategy is unavailable." })
        const output = outputStrategy.create({ prefix: null, request, generation, rolloutId })
        // A tool no longer registered is still offered as frozen; calling it is a tool error.
        const chat = yield* reader
          .GetChat({ userId: request.userId, chatId: request.chatId })
          .pipe(Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("GetChat")))
        const profile = execution.chatKinds.get(chat.kind)
        if (!profile)
          return yield* new GenerationFailed({ class: "unavailable", message: "This chat kind is unavailable." })
        const tools = frozen.tools.flatMap((t) => {
          const tool = execution.rolloutTools.get(t.name)
          return tool && (profile.allowsOutside || tool.effect !== "external") ? [tool] : []
        })
        const reply = strategy.run({
          purpose: profile.purpose,
          request,
          generation,
          rolloutId,
          output,
          providers,
          agent: {
            plan: {
              strategy: "agent",
              tools: tools.map((t) => t.id),
              contract: frozen.contract,
              turnCap: frozen.turnCap
            },
            mode: frozen.mode,
            checkpoints: (snapshot as ContinuousSnapshot).continuity?.breakpoints ?? [],
            allowsOutside: profile.allowsOutside,
            tools,
            offered: frozen.tools,
            reader,
            writer,
            onState: () => hub.publish(request.chatId, { _tag: "State" }),
            resume: {
              transcript: resume.transcript,
              historical: (snapshot as ContinuousSnapshot).continuity?.historical ?? 0,
              ...(resume.continuation === undefined ? {} : { continuation: resume.continuation })
            }
          },
          resolveImages: (input) =>
            hydrateMessageImages(
              input,
              model,
              (id) => reader.GetMediaFile({ userId: request.userId, mediaId: id }),
              config.dataDir
            )
        })
        return parsed(request, generation, reply)
      })

    const generate = (request: GenerationRequest) =>
      request.resume ? Stream.unwrap(resumed(request, request.resume)) : fresh(request)

    const fresh = (request: GenerationRequest) =>
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
          // The registered planner combines the chat settings at this point (spec/AGENTIC.md §6).
          const events = yield* reader
            .StateEventsAt({ userId, chatId, slotId: parent, forkId })
            .pipe(Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("StateEventsAt")))
          // Points that act before the reply is written (spec/AGENTIC.md §7): "Who replies next" may
          // give a reply Auto picked another speaker, which every tab hears before its first word.
          const changed = Option.isSome(decisions)
            ? yield* decisions.value.beforeReply({
                userId,
                chatId,
                slotId,
                versionId,
                forkId,
                parentSlotId: parent,
                version: slot.entry.version,
                events
              })
            : false
          // A reply the decision model was to choose a speaker for shows none until it's chosen:
          // when it wasn't (nothing to ask, no sure answer, no point to ask it), Auto's pick stands.
          const settled =
            slot.entry.version.speakerPick?.by === "auto"
              ? yield* writer
                  .SettleSpeaker({ userId, versionId })
                  .pipe(
                    Effect.catchTag(["StorageError", "RpcClientError"], (error) =>
                      Effect.as(Effect.logWarning("SettleSpeaker failed", error), false)
                    )
                  )
              : false
          if (changed || settled)
            yield* reader.GetSlot({ userId, slotId, forkId }).pipe(
              Effect.tap(({ entry }) => Effect.sync(() => hub.publish(chatId, { _tag: "Slot", entry }))),
              Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("GetSlot"))
            )
          const state = foldState(events)
          const chat = yield* reader
            .GetChat({ userId, chatId })
            .pipe(Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("GetChat")))
          const profile = execution.chatKinds.get(chat.kind)
          if (!profile)
            return yield* new GenerationFailed({ class: "unavailable", message: "This chat kind is unavailable." })
          const planned = planTurn(execution.orchestrationModes, state, chat.kind, profile.planner)
          if ("unavailable" in planned)
            return yield* new GenerationFailed({
              class: "unavailable",
              message: `The reply planner “${planned.unavailable}” is unavailable.`
            })
          // Continue keeps the source prefill; Write for remains a single plain turn.
          const plainTurn =
            request.initial !== undefined ||
            (slot.entry.version.speakerEntityId !== null &&
              state.playedByMe.includes(slot.entry.version.speakerEntityId))
          const plan = plainTurn
            ? { ...planned.plan, strategy: "reply", tools: [], contract: "final_text" as const }
            : planned.plan
          const agentic = plan.strategy !== "reply"
          const tools = plan.tools.flatMap((id) => {
            const tool = execution.rolloutTools.get(id)
            // Tools with effects outside the chat are never offered in an RP turn (DESIGN §7.3).
            return tool && (profile.allowsOutside || tool.effect !== "external") ? [tool] : []
          })
          let stepSummaries: Readonly<Record<string, string>> | undefined
          const assemblyNow = Date.now()
          const assembleWith = (admitted?: { readonly stamp: string; readonly lore: ReadonlyArray<LoreAdmission> }) =>
            reader
              .AssembleContext({
                userId,
                chatId,
                slotId,
                versionId,
                forkId,
                now: assemblyNow,
                timeZone: "UTC",
                frozen: null,
                partialBatch,
                ...(request.model ? { model: request.model } : {}),
                ...(admitted ? { decisions: admitted } : {}),
                ...(plan.assembly || agentic
                  ? {
                      agent: {
                        instructions:
                          plan.assembly?.instructions(
                            tools.map((t) => t.id),
                            plan.contract
                          ) ?? "",
                        speakerCardOnly: plan.assembly?.speakerCardOnly ?? false,
                        ...(plan.assembly?.workshop ? { workshop: true } : {}),
                        ...(stepSummaries ? { stepSummaries } : {})
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
          const assemble = assembleWith()
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
          // Lorebook entries the keys left out but that ask a decision model (spec/AGENTIC.md §7):
          // only when the user turned the point on for a connection. A yes is assembled in, and
          // frozen in the snapshot.
          if (assembled.loreDecision && Option.isSome(decisions) && decisions.value.points.get("lore")) {
            const outcome = yield* decisions.value.evaluate<LoreInput, ReadonlyArray<LoreAdmission>>(
              "lore",
              assembled.loreDecision,
              { userId, chatId, slotId, forkId, requestClass: "interactive" }
            )
            if (outcome.source === "model" && outcome.value.length > 0)
              assembled = yield* assembleWith({ stamp: assembled.loreDecision.stamp, lore: outcome.value })
          }
          let generation = JSON.parse(assembled.generation) as Generation
          let snapshot = JSON.parse(assembled.snapshot) as ContinuousSnapshot
          let continuity: ContinuityRecord | undefined
          let seed: ReadonlyArray<AgentMessage> | undefined
          if (agentic && plan.continuity === "resume_previous") {
            const path = yield* readContinuityPath(reader, request, parent).pipe(
              Effect.catch(serverFailure("ReadContinuityPath"))
            )
            const prior = yield* previousRun(reader, request, path, snapshot)
            const baseline = path.map(pathStamp)
            if ("reason" in prior)
              continuity = {
                path: baseline,
                reason: prior.reason,
                ...(generation.inspection ? { inspection: generation.inspection } : {})
              }
            else {
              // New user turns use the same rendered history pieces as plain assembly. Images
              // stay as references in storage, hydrated only when the request is dispatched.
              const additions: Array<AgentMessage> = prior.after.map((entry) => {
                const piece = snapshot.pieces.find(
                  (p) => p.source.kind === "message" && p.source.version === entry.version.id
                )
                const rendered =
                  piece?.messages.flatMap((i) =>
                    snapshot.request.messages[i] ? [snapshot.request.messages[i]!] : []
                  ) ?? []
                const imageIds = new Set((entry.version.images ?? []).map((image) => image.mediaId))
                const images = rendered
                  .flatMap((message) => message.images ?? [])
                  .filter((image) => imageIds.has(image.mediaId) && image.estimate?.sent !== false)
                const message = {
                  role: "user" as const,
                  content: piece?.text ?? entry.version.content,
                  ...(rendered[0]?.name ? { name: rendered[0].name } : {}),
                  ...(images.length ? { images } : {})
                }
                if (imageIds.size && snapshot.inputs.model?.vision === false) message.content += " [image]"
                return { role: "rpUser", message, timestamp: entry.version.createdAt }
              })
              seed = [...prior.transcript, ...additions]
              const budget = snapshot.contextBudget
              const count = yield* reader
                .CountRolloutContext({
                  model: JSON.stringify(snapshot.inputs.model),
                  request: JSON.stringify(prior.snapshot.request),
                  transcript: JSON.stringify(seed),
                  tools: JSON.stringify([
                    ...tools.map(frozenTool),
                    ...(plan.contract === "final_text"
                      ? []
                      : [plan.contract === "several" ? severalMessageDefinition : sendMessageDefinition])
                  ])
                })
                .pipe(Effect.catch(serverFailure("CountRolloutContext")))
              // Provider image limits apply to the entire request. Hydrating the prefix
              // and each carried user message separately must not evict a cached image.
              const imageCount = [
                ...prior.snapshot.request.messages,
                ...seed.flatMap((message) => (message.role === "rpUser" ? [message.message] : []))
              ].reduce((total, message) => total + (message.images?.length ?? 0), 0)
              const imageOverflow =
                snapshot.inputs.model?.vision !== false &&
                additions.some((message) => message.role === "rpUser" && (message.message.images?.length ?? 0) > 0) &&
                imageCount > (snapshot.inputs.model?.maxImages ?? DEFAULT_MAX_IMAGES)
              if (imageOverflow || (budget && count > budget.maximum - budget.responseReserve)) {
                seed = undefined
                continuity = {
                  path: baseline,
                  reason: imageOverflow
                    ? "The previous run exceeded the image limit, so this request was put together again from the messages."
                    : "The previous run outgrew the context budget, so this request was put together again from the messages."
                }
                if (WORKSHOP_OVERFLOW_STEP_SUMMARIES) {
                  stepSummaries = yield* summarizeMessageSteps(reader, request, path)
                  assembled = yield* assembleWith()
                  snapshot = JSON.parse(assembled.snapshot) as ContinuousSnapshot
                  generation = JSON.parse(assembled.generation) as Generation
                }
              } else {
                const priorWire = providerRequest(prior.snapshot.request, snapshot.inputs.model!)
                const lastRequest = prior.transcript.findLastIndex((m) => m.role === "assistant")
                const lastTail =
                  priorWire.context.messages.length + liveSuffix(prior.transcript.slice(0, lastRequest)).length - 1
                continuity = {
                  path: baseline,
                  parent: { rolloutId: prior.material.rolloutId, versionId: prior.versionId },
                  historical: prior.transcript.length,
                  prefix:
                    prior.snapshot.continuity?.prefix ??
                    (() => {
                      const { continuity: _continuity, ...prefix } = prior.snapshot
                      return prefix
                    })(),
                  ...(prior.snapshot.continuity?.inspection
                    ? { inspection: prior.snapshot.continuity.inspection }
                    : {}),
                  breakpoints: [
                    ...(prior.snapshot.continuity?.breakpoints ?? (priorWire.stable ? [priorWire.stable.message] : [])),
                    ...(snapshot.inputs.model?.cacheBreakpoints !== "none" ? [lastTail] : [])
                  ]
                }
                snapshot = { ...snapshot, request: prior.snapshot.request }
                generation = {
                  ...generation,
                  request: prior.snapshot.request,
                  ...(continuity.inspection ? { inspection: continuity.inspection } : {})
                }
              }
            }
          }
          const { model } = generation
          if (model === null) {
            return yield* new GenerationFailed({
              class: "no_model",
              message: "No model is chosen: bind one to this chat, or choose a default model."
            })
          }
          const rolloutId = uuidv7()
          const finish = finishing(request, rolloutId)
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
                ? `${JSON.stringify({ ...snapshot, ...(continuity ? { continuity } : {}) }).slice(0, -1)},"agent":${JSON.stringify(
                    {
                      mode: planned.mode,
                      contract: plan.contract,
                      turnCap: plan.turnCap,
                      inspection: generation.inspection,
                      tools: [
                        ...tools.map(frozenTool),
                        ...(plan.contract === "final_text"
                          ? []
                          : [plan.contract === "several" ? severalMessageDefinition : sendMessageDefinition])
                      ]
                    }
                  )}}`
                : assembled.snapshot,
              ...(continuity?.parent ? { parentRolloutId: continuity.parent.rolloutId } : {}),
              ...(seed ? { transcript: JSON.stringify(seed) } : {}),
              ...(agentic ? { mode: planned.mode } : {}),
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
            prefix: !agentic && model.prefill === "tool_schema" ? generation.request.prefill : null,
            request,
            generation,
            rolloutId
          })
          const strategy = execution.replyStrategies.get(plan.strategy)
          if (!strategy)
            return yield* new GenerationFailed({ class: "unavailable", message: "Reply strategy is unavailable." })
          const reply = strategy.run({
            purpose: profile.purpose,
            request,
            generation,
            rolloutId,
            output,
            providers,
            ...(agentic
              ? {
                  agent: {
                    plan,
                    ...(seed ? { resume: { transcript: seed, historical: continuity?.historical ?? 0 } } : {}),
                    mode: planned.mode,
                    checkpoints: continuity?.breakpoints ?? [],
                    allowsOutside: profile.allowsOutside,
                    tools,
                    reader,
                    writer,
                    onState: () => hub.publish(chatId, { _tag: "State" })
                  }
                }
              : {}),
            resolveImages: (input) =>
              hydrateMessageImages(input, model, (id) => reader.GetMediaFile({ userId, mediaId: id }), config.dataDir)
          })
          return parsed(request, generation, emptyAfterPrefill(request, generation, agentic, reply))
        })
      )

    return Option.some({ generate })
  })
)
