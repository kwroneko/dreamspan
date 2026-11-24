import { admitsEffect, outsideEffect } from "../agent/effects.ts"
import { toolForKind } from "../execution.ts"
import { DEFAULT_MAX_IMAGES } from "../assembler/images.ts"
import { providerRequest } from "../assembler/wire.ts"
import { liveSuffix } from "../agent/messages.ts"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  previousRun,
  storyReadStamp,
  readContinuityPath,
  pathStamp,
  summarizeMessageSteps,
  WORKSHOP_OVERFLOW_STEP_SUMMARIES,
  ELIDE_TRIGGER,
  elideCarried,
  type ContinuousSnapshot,
  type ContinuityRecord
} from "../agent/continuity.ts"
import { AppConfig } from "../config.ts"
import { hydrateMessageImages } from "./messageImages.ts"
import { executionRegistry } from "../execution.ts"
import { Summarizer } from "../lcm/Summarizer.ts"
// The real generator: assembly, rollout, provider stream (ARCHITECTURE §15, "Generation").
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { imagesOnly, type SlotId, type VersionId } from "@dreamspan/shared/chat.ts"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import { type ContextSnapshot, type Generation, generationOf } from "../assembler/types.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Providers } from "../providers/Providers.ts"
import { GenerationFailed, type GenerationRequest, Generator } from "./Generator.ts"
import { throughParse } from "./replySections.ts"
import { ChatHub } from "./ChatHub.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { planTurn } from "../agent/modes.ts"
import type { OutputContract } from "../agent/modes.ts"
import {
  type FrozenTool,
  frozenTool,
  offeredFor,
  type RolloutTool,
  noReplyDefinition,
  sendMessageDefinition,
  sendMessageWithPresence,
  severalMessageDefinition,
  prepareToolSnapshots,
  toolWriter
} from "../agent/tools.ts"
import { makePermit, offeredByGrants } from "../agent/approvals.ts"
import { makeLibrarySight } from "../agent/librarySight.ts"
import { loaderFor, loadingWireFor, offerableTools, planToolLoading, skillMarkerInput } from "../agent/loadingPlan.ts"
import { dispatcherDefinition } from "../agent/dispatcher.ts"
import { frozenOffer, loadedSet, type Skill } from "../agent/toolLoading.ts"
import { DecisionEngine } from "../decision/engine.ts"
import { McpConnections } from "../mcp/McpConnections.ts"
import {
  enabledServers,
  enabledStoryServers,
  mcpLoadingOverrides,
  mcpOfferTools,
  mcpSkillOf,
  mcpToolFromFrozen,
  readResultTool
} from "../agent/tools/mcp.ts"
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
    // MCP servers' tools (spec/MCP.md M2), where the server runs the MCP client.
    const mcp = Option.getOrUndefined(yield* Effect.serviceOption(McpConnections))

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
            /** Absent: no cap (a workshop's). */
            readonly turnCap?: number
            readonly tools: ReadonlyArray<FrozenTool>
            readonly cardSkills?: ReadonlyArray<Skill>
            readonly inspection?: Generation["inspection"]
            /** A story branch's own MCP server choices at the reply's parent (`agent.mcp`). */
            readonly mcpChoices?: Readonly<Record<string, boolean>>
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
          const tool =
            toolForKind(execution, chat.kind, t.name) ??
            loaderFor(execution, t) ??
            mcpToolFromFrozen(mcp, t) ??
            (t.name === readResultTool.id ? (readResultTool as unknown as RolloutTool<never>) : undefined)
          return tool && admitsEffect(profile, tool.effect) ? [tool] : []
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
              ...(frozen.turnCap === undefined ? {} : { turnCap: frozen.turnCap })
            },
            mode: frozen.mode,
            ...(snapshot.sendNudge === undefined ? {} : { sendNudge: snapshot.sendNudge }),
            checkpoints: (snapshot as ContinuousSnapshot).continuity?.breakpoints ?? [],
            recentPrefix: ((snapshot as ContinuousSnapshot).continuity?.prefix ?? snapshot).lcm?.measure?.recentNow,
            allowsOutside: profile.allowsOutside,
            tools,
            offered: frozen.tools,
            kind: chat.kind,
            cardSkills: frozen.cardSkills ?? [],
            ...(loadingWireFor(execution, model) ? { loadingWire: loadingWireFor(execution, model)! } : {}),
            reader,
            writer,
            ...(profile.allowsOutside
              ? {
                  sight: makeLibrarySight({
                    registries: execution,
                    reader,
                    writer,
                    userId: request.userId,
                    chatId: request.chatId,
                    rolloutId
                  })
                }
              : {}),
            permit: makePermit({
              registries: execution,
              reader,
              writer,
              userId: request.userId,
              chatId: request.chatId,
              rolloutId,
              ...(profile.allowsOutside
                ? {}
                : { story: { mcpChoices: frozen.mcpChoices ?? {}, choicesNow: branchMcpNow(request) } })
            }),
            onChanged: (target) => {
              hub.publish(target, { _tag: "Reload" })
              hub.publish(target, { _tag: "Lcm" })
            },
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

    /**
     * A story branch's MCP choices now, at the reply's own slot (spec/MCP.md §5.1): a server the
     * user turned off there after the run began is off for its calls, a Resume's included.
     */
    const branchMcpNow = (request: GenerationRequest) =>
      reader
        .StateEventsAt({
          userId: request.userId,
          chatId: request.chatId,
          slotId: request.slotId,
          forkId: request.forkId ?? null
        })
        .pipe(Effect.map((events) => foldState(events).agentMcp ?? {}))

    const generate = (request: GenerationRequest) =>
      request.resume ? Stream.unwrap(resumed(request, request.resume)) : fresh(request)

    const fresh = (request: GenerationRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { userId, chatId, slotId, versionId } = request
          // Read in the fork it was started in: the chat's current fork may be another by now.
          const forkId = request.forkId ?? null
          let slot = yield* reader
            .GetSlot({ userId, slotId, forkId })
            .pipe(Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("GetSlot")))
          const parent = slot.entry.parentSlotId
          const partialBatch =
            parent && !request.replyOnly
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
          const changed =
            !request.replyOnly && Option.isSome(decisions)
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
          // when it wasn't, the decision point can settle to an eligible fallback before this default.
          const settled =
            slot.entry.version.speakerPick?.by === "auto"
              ? yield* writer
                  .SettleSpeaker({ userId, versionId })
                  .pipe(
                    Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], (error) =>
                      Effect.as(Effect.logWarning("SettleSpeaker failed", error), false)
                    )
                  )
              : false
          if (changed || settled)
            slot = yield* reader.GetSlot({ userId, slotId, forkId }).pipe(
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
          // Another version of a silent line asks for an actual reply (spec/REPLY-CONTRACT.md §3.1):
          // a reply written where the character already passed may not pass again.
          const passedHere =
            !plainTurn && planned.plan.noReply === true && slot.entry.versionCount > 1
              ? (yield* reader
                  .ListVersions({ userId, slotId, forkId })
                  .pipe(
                    Effect.catchTag(["StorageError", "RpcClientError", "NotFound"], serverFailure("ListVersions"))
                  )).some((v) => v.id !== versionId && v.mark === "silent")
              : false
          const plan = plainTurn
            ? { ...planned.plan, strategy: "reply", tools: [], contract: "final_text" as const }
            : passedHere
              ? { ...planned.plan, noReply: false }
              : planned.plan
          if (plan.sendPresence && plan.contract !== "final_text" && (state.contextPerSpeaker ?? "shared") === "shared")
            return yield* new GenerationFailed({
              class: "context_view",
              message:
                "Replies that say who's in the scene need Separate contexts. Choose Separate contexts, or set Who's in the scene to Replies don't say."
            })
          const agentic = plan.strategy !== "reply"
          // The MCP servers on in this workshop or for this story branch (spec/MCP.md §5.1), read
          // from storage: planning never reaches a server. A story's own choices are the branch's
          // at the reply's parent, frozen with the run.
          const storyMcp = agentic && mcp !== undefined && admitsEffect({ ...profile, allowsOutside: false }, "mcp")
          const mcpChoices = state.agentMcp ?? {}
          const mcpListed =
            agentic && mcp && !profile.allowsOutside
              ? storyMcp
                ? enabledStoryServers(
                    yield* reader
                      .McpStoryConnections({ userId })
                      .pipe(Effect.catchTag(["StorageError", "RpcClientError"], serverFailure("McpStoryConnections"))),
                    mcpChoices
                  )
                : []
              : agentic && mcp && profile.allowsOutside
                ? enabledServers(
                    yield* reader
                      .McpWorkshopConnections({ userId, chatId })
                      .pipe(
                        Effect.catchTag(
                          ["StorageError", "RpcClientError", "NotFound"],
                          serverFailure("McpWorkshopConnections")
                        )
                      )
                  )
                : []
          // A local program's tools are offered only where the instance runs local programs.
          const mcpServers = mcpListed.filter((entry) => entry.connection.transport !== "stdio" || mcp?.localPrograms)
          const candidates = [
            ...plan.tools.flatMap((id) => {
              const tool = toolForKind(execution, chat.kind, id)
              // Tools with effects outside the chat are never offered in an RP turn (DESIGN §7.3).
              return tool && (profile.allowsOutside || !outsideEffect(tool.effect)) ? [tool] : []
            }),
            // After the built-in tools: servers in creation order, each one's tools by name (§4.3).
            ...(mcp && mcpServers.length ? mcpOfferTools(mcp, mcpServers) : []),
            // A story pages a long server result with read_result, which reads only this run (§9).
            ...(mcp && mcpServers.length && !profile.allowsOutside
              ? [readResultTool as unknown as RolloutTool<never>]
              : [])
          ]
          // A capability turned off in the workshop isn't offered (spec/WORKSHOP.md §3.4).
          const { tools, off } = yield* offeredByGrants({ registries: execution, reader, userId, chatId }, candidates)
          let stepSummaries: Readonly<Record<string, string>> | undefined
          // The run's skills for the preset's skill markers, from what the loading plan lists them by.
          const markerSkills = agentic
            ? skillMarkerInput(execution, chat.kind, yield* offerableTools({ reader, userId }, tools))
            : undefined
          // A workshop turn's tail lines (agent/turnNotes.ts), such as its working folder.
          const notes = plan.assembly?.workshop
            ? (yield* Effect.forEach(execution.turnNotes.list(), (note) =>
                note
                  .line({
                    userId,
                    chatId,
                    forkId,
                    leafSlotId: parent,
                    kind: chat.kind,
                    state,
                    offered: tools.map((t) => t.id)
                  })
                  .pipe(Effect.orElseSucceed(() => null))
              )).flatMap((line) => {
                const note = typeof line === "string" ? { text: line, events: [] } : line
                return note?.text.trim() ? [note] : []
              })
            : []
          const turnNotes = notes.map((note) => note.text)
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
                            plan.contract,
                            { off, noReply: plan.noReply === true }
                          ) ?? "",
                        speakerCardOnly: plan.assembly?.speakerCardOnly ?? false,
                        ...(plan.assembly?.workshop ? { workshop: true } : {}),
                        ...(turnNotes.length ? { turnNotes } : {}),
                        ...(plan.assembly?.response ? { response: plan.assembly.response } : {}),
                        ...(stepSummaries ? { stepSummaries } : {}),
                        ...(markerSkills ? { skills: markerSkills } : {})
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
          if (
            !request.replyOnly &&
            assembled.loreDecision &&
            Option.isSome(decisions) &&
            decisions.value.points.get("lore")
          ) {
            const outcome = yield* decisions.value.evaluate<LoreInput, ReadonlyArray<LoreAdmission>>(
              "lore",
              assembled.loreDecision,
              { userId, chatId, slotId, forkId, requestClass: "interactive" }
            )
            if (outcome.source === "model" && outcome.value.length > 0)
              assembled = yield* assembleWith({ stamp: assembled.loreDecision.stamp, lore: outcome.value })
          }
          // Points a connection has on that this chat turned off (`decision.points`): nothing was
          // asked; the snapshot says which, so the inspector can say what decided instead.
          const decisionsOff =
            !request.replyOnly && Option.isSome(decisions) && state.decisionsOff?.length
              ? yield* decisions.value.skippedIn(userId, { state, loreAsked: assembled.loreDecision !== undefined })
              : []
          let generation = JSON.parse(assembled.generation) as Generation
          let snapshot = JSON.parse(assembled.snapshot) as ContinuousSnapshot
          if (request.storyAt)
            snapshot = {
              ...snapshot,
              storyStamp:
                (yield* storyReadStamp(reader, request.userId, request.storyAt).pipe(
                  Effect.catch(serverFailure("StoryReadStamp"))
                )) ?? null
            }
          // Definitions that depend on this chat at the run's position (the agent tool's models).
          const runTools = agentic
            ? yield* offeredFor(tools, {
                reader,
                userId,
                chatId,
                forkId: forkId ?? null,
                leafSlotId: generation.leafSlotId as SlotId | null,
                contract: plan.contract,
                kind: chat.kind,
                execution
              })
            : tools
          // Dynamic tool loading (spec/TOOL-LOADING.md): what's sent from the start, what's loaded later.
          const { offer, cardSkills } = agentic
            ? yield* planToolLoading(
                { execution, reader, userId },
                {
                  kind: chat.kind,
                  tools: runTools,
                  model: generation.model,
                  // Each server is a skill: its index line is the user's own "What it's for". Its
                  // "Send its tools" decides, in both kinds, whether its tools wait for loading.
                  skills: mcpServers.map((entry) => mcpSkillOf(entry.connection, !profile.allowsOutside)),
                  ...(mcpServers.length ? { loading: mcpLoadingOverrides(mcpServers, !profile.allowsOutside) } : {}),
                  // A story's cards bring no skills: only its servers' tools can wait for loading.
                  cards: profile.allowsOutside
                    ? snapshot.inputs.cards.filter((c) => !state.playedByMe.includes(c.entity as never))
                    : []
                }
              )
            : { offer: { tools: runTools, deferred: new Set<string>() }, cardSkills: [] }
          const contractTools =
            plan.contract === "final_text"
              ? []
              : [
                  plan.contract === "several"
                    ? severalMessageDefinition
                    : plan.sendPresence
                      ? sendMessageWithPresence(plan.sendPresence)
                      : sendMessageDefinition,
                  // The pass beside the send (spec/REPLY-CONTRACT.md §3.1), frozen with it for Resume.
                  ...(plan.noReply && plan.contract === "send_message" ? [noReplyDefinition] : [])
                ]
          const frozenTools: ReadonlyArray<FrozenTool> = [
            ...frozenOffer(offer.tools, offer.deferred, frozenTool),
            ...contractTools,
            ...(offer.deferred.size && loadingWireFor(execution, generation.model)?.dispatcher
              ? [{ ...dispatcherDefinition, label: "Called a loaded tool", effect: "read" as const }]
              : [])
          ]
          let continuity: ContinuityRecord | undefined
          let seed: ReadonlyArray<AgentMessage> | undefined
          if (agentic && plan.continuity === "resume_previous") {
            const path = yield* readContinuityPath(reader, request, parent).pipe(
              Effect.catch(serverFailure("ReadContinuityPath"))
            )
            const prior = yield* previousRun(reader, request, path, {
              ...snapshot,
              agent: { tools: frozenTools, cardSkills }
            })
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
                // The last such piece: a later stage's (its attachment lines) stands for the message.
                const piece = snapshot.pieces.findLast(
                  (p) => p.source.kind === "message" && p.source.version === entry.version.id
                )
                const rendered =
                  piece?.messages.flatMap((i) =>
                    snapshot.request.messages[i] ? [snapshot.request.messages[i]!] : []
                  ) ?? []
                const imageIds = new Set(imagesOnly(entry.version.images ?? []).map((image) => image.mediaId))
                const images = rendered
                  .flatMap((message) => message.images ?? [])
                  .filter((image) => imageIds.has(image.mediaId) && image.estimate?.sent !== false)
                const message = {
                  role: "user" as const,
                  content: piece?.text ?? entry.version.content,
                  ...(rendered[0]?.name ? { name: rendered[0].name } : {}),
                  ...(images.length ? { images } : {})
                }
                // A workshop's images saved in Files are named by their attachment lines already.
                if (imageIds.size && snapshot.inputs.model?.vision === false && !piece?.text.includes("<attachment "))
                  message.content += " [image]"
                return { role: "rpUser", message, timestamp: entry.version.createdAt }
              })
              // A workshop's tail lines (the working folder, agent/turnNotes.ts) are told again
              // only on a turn after they changed: with the new user turn, after the cached prefix.
              // Only the lines that are new are told, so one line's change doesn't repeat the rest.
              const told = prior.snapshot.agentAssembly?.turnNotes ?? []
              const newNotes = notes.filter((note) => note.events.length > 0 || !told.includes(note.text))
              if (newNotes.length) {
                const text = newNotes.map((note) => note.text).join("\n")
                const last = additions.at(-1)
                if (last?.role === "rpUser")
                  additions[additions.length - 1] = {
                    ...last,
                    message: { ...last.message, content: `${last.message.content}\n${text}` }
                  }
                else
                  additions.push({
                    role: "rpUser",
                    message: { role: "user", content: text },
                    timestamp: Date.now()
                  })
              }
              seed = [...prior.transcript, ...additions]
              const budget = snapshot.contextBudget
              const countSeed = (transcript: ReadonlyArray<AgentMessage>) =>
                reader
                  .CountRolloutContext({
                    model: JSON.stringify(snapshot.inputs.model),
                    request: JSON.stringify(prior.snapshot.request),
                    transcript: JSON.stringify(transcript),
                    // A deferred tool takes context only once it's loaded.
                    tools: JSON.stringify(
                      frozenTools.some((t) => t.name === "call_tool")
                        ? frozenTools
                        : frozenTools.filter(
                            (t) =>
                              (t as { readonly deferred?: true }).deferred !== true ||
                              loadedSet(transcript, offer.deferred).has(t.name)
                          )
                    )
                  })
                  .pipe(Effect.catch(serverFailure("CountRolloutContext")))
              let count = yield* countSeed(seed)
              // Past the trigger, older tool results are left out before anything is rebuilt
              // (spec/WORKSHOP-CONTEXT.md §2.2): the prefix and everything before them stay cached.
              let elided = 0
              const room = budget ? budget.maximum - budget.responseReserve : Number.POSITIVE_INFINITY
              let needsRebuild = count > room * ELIDE_TRIGGER
              if (needsRebuild && !state.lcm?.enabled) {
                const compacted = yield* elideCarried({
                  quoteResults: profile?.allowsOutside === true,
                  reader,
                  request,
                  path,
                  transcript: prior.transcript,
                  count,
                  room,
                  recount: (transcript) => countSeed([...transcript, ...additions])
                }).pipe(Effect.catch(serverFailure("ElideCarried")))
                if (compacted && compacted.count <= room) {
                  seed = [...compacted.transcript, ...additions]
                  count = compacted.count
                  elided = compacted.elided
                  needsRebuild = false
                }
              }
              if (state.lcm?.enabled) needsRebuild = false
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
              if (
                imageOverflow ||
                needsRebuild ||
                (!state.lcm?.enabled && budget && count > budget.maximum - budget.responseReserve)
              ) {
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
                  ...(elided > 0 ? { elided } : {}),
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
          if (agentic && plan.assembly?.workshop) {
            // A carried turn adds its notes to the new suffix. A rebuilt turn sends the assembled
            // notes whose pieces survived into the request. Even an empty list tracks dispatch.
            const turnEvents = notes.flatMap((note, i) =>
              seed || snapshot.pieces.some((piece) => piece.id === `workshop:turn-note:${i}` && piece.messages.length)
                ? note.events
                : []
            )
            snapshot = { ...snapshot, turnEvents }
          }
          const rolloutId = uuidv7()
          if (agentic) {
            const prepared = yield* prepareToolSnapshots(runTools, {
              userId,
              chatId,
              slotId,
              versionId,
              forkId: forkId ?? null,
              leafSlotId: generation.leafSlotId as SlotId | null,
              viewers: generation.viewers,
              rolloutId,
              toolCallId: "",
              cache: new Map(),
              reader,
              writer: toolWriter(writer)
            }).pipe(Effect.catchCause((cause) => serverFailure("PrepareToolSnapshots")(cause)))
            // The snapshot keeps the frozen form; this run reads the prepared state itself.
            if (Object.keys(prepared.frozen).length > 0) snapshot = { ...snapshot, agentToolState: prepared.frozen }
            if (Object.keys(prepared.state).length > 0) generation = { ...generation, agentToolState: prepared.state }
          }
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
                ? `${JSON.stringify({ ...snapshot, ...(request.storyAt ? { storyAt: request.storyAt } : {}), ...(continuity ? { continuity } : {}), ...(decisionsOff.length ? { decisionsOff } : {}) }).slice(0, -1)},"agent":${JSON.stringify(
                    {
                      mode: planned.mode,
                      contract: plan.contract,
                      turnCap: plan.turnCap,
                      inspection: generation.inspection,
                      tools: frozenTools,
                      ...(cardSkills.length ? { cardSkills } : {}),
                      ...(storyMcp && Object.keys(mcpChoices).length ? { mcpChoices } : {})
                    }
                  )}}`
                : decisionsOff.length
                  ? `${assembled.snapshot.slice(0, -1)},"decisionsOff":${JSON.stringify(decisionsOff)}}`
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
            // An Auto turn whose chat changed before its request was made (db/autoGuard.ts).
            Effect.catchTag("AutoRefused", (refused) =>
              Effect.fail(
                new GenerationFailed({
                  class: "auto_refused",
                  message:
                    refused.reason === "settings"
                      ? "Not sent: your settings changed after auto replies started this reply."
                      : "Not sent: this chat changed after auto replies started this reply."
                })
              )
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
                    ...(snapshot.sendNudge === undefined ? {} : { sendNudge: snapshot.sendNudge }),
                    ...(seed ? { resume: { transcript: seed, historical: continuity?.historical ?? 0 } } : {}),
                    mode: planned.mode,
                    checkpoints: continuity?.breakpoints ?? [],
                    recentPrefix: (continuity?.prefix ?? snapshot).lcm?.measure?.recentNow,
                    allowsOutside: profile.allowsOutside,
                    tools: offer.tools,
                    offered: frozenTools,
                    kind: chat.kind,
                    cardSkills,
                    ...(loadingWireFor(execution, model) ? { loadingWire: loadingWireFor(execution, model)! } : {}),
                    reader,
                    writer,
                    ...(profile.allowsOutside
                      ? {
                          sight: makeLibrarySight({ registries: execution, reader, writer, userId, chatId, rolloutId })
                        }
                      : {}),
                    permit: makePermit({
                      registries: execution,
                      reader,
                      writer,
                      userId,
                      chatId,
                      rolloutId,
                      ...(profile.allowsOutside ? {} : { story: { mcpChoices, choicesNow: branchMcpNow(request) } })
                    }),
                    onChanged: (target) => {
                      hub.publish(target, { _tag: "Reload" })
                      hub.publish(target, { _tag: "Lcm" })
                    },
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

    return Option.some({ kind: "provider" as const, generate, requiresModel: true })
  })
)
