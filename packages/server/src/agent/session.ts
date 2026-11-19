import { toolData, toolDataPage, TOOL_RESULT_CHARS } from "./toolData.ts"
import { admitsEffect, outsideEffect, UNCERTAIN_EFFECT } from "./effects.ts"
// The agent reply strategy (spec/AGENTIC.md §3): a pi-agent-core loop over the frozen request.
// The assembler built the context once; each provider request is that prefix plus the
// rollout's own transcript (wire.ts), sent through the provider layer so its ledger, retries,
// proxy, transforms and inspector capture apply. The loop's output is the same chunk stream a
// plain reply yields, so reply parsers, live rewrites and the version's persistence treat both
// alike (DESIGN §7.2: one commit pipeline). The transcript is flushed as each turn ends.
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type StreamFn
} from "@earendil-works/pi-agent-core"
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Tool,
  Type
} from "@earendil-works/pi-ai"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import { Cause, Effect, Exit, Fiber, Option, Queue, Result, Stream } from "effect"
import type { AssembledRequest, Generation } from "../assembler/types.ts"
import { providerRequest } from "../assembler/wire.ts"
import type { Reader, Writer } from "../db/Database.ts"
import { GenerationFailed, type GenerationChunk, type GenerationRequest } from "../chat/Generator.ts"
import type { ReplyOutputStrategy } from "../chat/replyOutput.ts"
import type { Providers, ProviderError } from "../providers/Providers.ts"
import { ProviderRegistry } from "../providers/registry.ts"
import type { AgentPlan } from "./modes.ts"
import { countSteps, NO_REPLY, SEND_MESSAGE, stepsOf } from "./steps.ts"
import { SEND_NUDGES, sendNudgeText } from "@dreamspan/shared/agentInstructions.ts"
import { danglingCalls } from "./resume.ts"
import type { ApprovalPrompt, SubagentRow } from "@dreamspan/shared/agent.ts"
import type { PermitInput, PermitResult } from "./approvals.ts"
import {
  budgetResult,
  type FrozenTool,
  frozenTool,
  sendMessageDefinition,
  sendPresenceOf,
  severalMessageDefinition,
  type RolloutTool,
  type ToolOutput,
  toolWriter
} from "./tools.ts"
import { forTarget, rolloutRequest } from "./wire.ts"
import { declarePresence } from "./tools/sendPresence.ts"
import {
  BAD_ARGS,
  CALL_TOOL,
  countedTools,
  dispatcherDefinition,
  dispatcherMessages,
  dispatchRefusal,
  fitsTool,
  missingTool,
  resolveDispatch
} from "./dispatcher.ts"
import { cutAnswersIn, liveSuffix, nudgesIn, sendOnlyTranscript } from "./messages.ts"
import { loadedSet, loadPoints, type Skill, type ToolLoadingWire } from "./toolLoading.ts"
import { executionRegistry } from "../execution.ts"

/** What an agent turn needs beyond a plain reply's. */
export interface AgentRun {
  readonly allowsOutside?: boolean
  readonly checkpoints?: ReadonlyArray<number>
  /** Verbatim history already inside the frozen prefix, counted by assembly. */
  readonly recentPrefix?: number | undefined
  readonly plan: AgentPlan
  readonly mode: string
  readonly tools: ReadonlyArray<RolloutTool<never>>
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly onChanged?: (chatId: import("@dreamspan/shared/chat.ts").ChatId) => void
  readonly onState?: () => void
  /** The tool definitions to offer as frozen into the snapshot; absent: `tools`' own. */
  readonly offered?: ReadonlyArray<FrozenTool>
  /** The chat kind, for the loading tools' skill lookups (spec/TOOL-LOADING.md). */
  readonly kind?: string
  /** All offered skills, frozen with the run (the persisted field retains its original name). */
  readonly cardSkills?: ReadonlyArray<Skill>
  /** How this model's wire API carries deferred tools; absent: every tool is sent from the start. */
  readonly loadingWire?: ToolLoadingWire
  /**
   * The preset's own "When the reply wasn't sent" text, frozen with the run's snapshot
   * (spec/REPLY-CONTRACT.md §3.3); absent: the default.
   */
  readonly sendNudge?: string
  /** Carrying on a stopped run (resume.ts): its kept transcript, and text cut off to continue. */
  readonly resume?: {
    readonly transcript: ReadonlyArray<unknown>
    readonly continuation?: string
    readonly historical?: number
  }
  /**
   * Whether a call may run now (approvals.ts): its capability's standing, asking the user first
   * where it says so. Absent: every offered call runs.
   */
  readonly permit?: (input: PermitInput) => Effect.Effect<PermitResult>
  /**
   * This run is a subagent (spec/SUBAGENTS.md): its tools get no host to start one of their own,
   * its last request says `writeNow`, and it isn't summarized as it goes (that's SA7's).
   */
  readonly subagent?: { readonly writeNow: string }
}

export interface AgentStrategyInput {
  readonly purpose?: "generation" | "workshop"
  readonly resolveImages: (input: AssembledRequest) => Effect.Effect<AssembledRequest, GenerationFailed>
  readonly request: GenerationRequest
  readonly generation: Generation
  readonly rolloutId: string
  readonly output: ReturnType<ReplyOutputStrategy["create"]>
  readonly providers: Providers["Service"]
  readonly agent?: AgentRun
}

export const WRITE_NOW = "Write the reply now."

/**
 * What a reply that never sent fails with (spec/REPLY-CONTRACT.md §3.4): `times` plain turns,
 * the nudges' and the first. Resume and Regenerate are offered on it.
 */
const contractFailure = (times: number) =>
  new GenerationFailed({
    class: "contract",
    message: `The model didn't send a reply: it wrote text ${times} times without calling send_message.`
  })

/** A tool result's `details` when a stop cut the call off: resume runs the call again. */
const INTERRUPTED = { interrupted: true } as const

/**
 * How often a turn being streamed is saved as it is (spec/AGENTIC.md §12.2), as a plain reply's
 * text is (Generations): a process killed mid-turn leaves it as a stop would, so Resume carries
 * its text on instead of losing it.
 */
const PARTIAL_SAVE_MS = 2000

/**
 * The contract's tool (DESIGN §7.2): the message, ending the turn; one a turn. Where the chat
 * has the tool say who is present (`definition` takes `present`), `declare` records it with the
 * message before the message is taken; its refusal (a name nobody in the chat has) goes back to
 * the model, which sends again.
 */
const sendMessageTool = (
  definition: FrozenTool,
  send: { readonly sent: () => boolean; readonly take: (message: string) => boolean; readonly passed?: () => boolean },
  declare?: (toolCallId: string, present: ReadonlyArray<string>) => Promise<string | null>
): AgentTool => {
  const presence = sendPresenceOf(definition)
  const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], details: null, isError: true })
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters as AgentTool["parameters"],
    executionMode: "sequential",
    execute: async (id, params) => {
      const { message, present } = params as { message: string; present?: unknown }
      if (send.passed?.()) return refuse("You passed this turn with no_reply: nothing more is sent.")
      if (send.sent()) return refuse("Only one message a turn: the first one was sent.")
      if (presence !== null && declare) {
        const names = Array.isArray(present) && present.every((name) => typeof name === "string") ? present : null
        if (present !== undefined && names === null) return refuse(PRESENT_NEEDED)
        if (names === null && presence === "required") return refuse(PRESENT_NEEDED)
        if (names !== null) {
          const refusal = await declare(id, names)
          if (refusal !== null) return refuse(refusal)
        }
      }
      const sent = send.take(message)
      return sent
        ? { content: [{ type: "text", text: "Sent." }], details: null, terminate: true }
        : refuse("Only one message a turn: the first one was sent.")
    }
  }
}

/**
 * The pass (spec/REPLY-CONTRACT.md §3.1): the character says nothing this turn. It ends the turn
 * like a send; after a send, or a second time, it's refused.
 */
const noReplyTool = (
  definition: FrozenTool,
  pass: { readonly sent: () => boolean; readonly take: () => boolean }
): AgentTool => ({
  name: definition.name,
  label: definition.label,
  description: definition.description,
  parameters: definition.parameters as AgentTool["parameters"],
  executionMode: "sequential",
  execute: async () =>
    !pass.sent() && pass.take()
      ? { content: [{ type: "text", text: "Passed." }], details: null, terminate: true }
      : {
          content: [{ type: "text", text: "The reply has already been given this turn." }],
          details: null,
          isError: true
        }
})

/** A send that had to say who is present and didn't, or said it as something other than names. */
const PRESENT_NEEDED =
  "Say who is in the scene: send the message again with `present`, the names of the characters there for it."

const emptyAssistant = (model: Model<Api>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: "stop",
  timestamp: Date.now()
})

const failedOf = (error: ProviderError | GenerationFailed, modelId: string): GenerationFailed =>
  error._tag === "GenerationFailed"
    ? error
    : new GenerationFailed({
        class: error.reason,
        message: error.message,
        ...(error.contextLimit === undefined ? {} : { contextLimit: { tokens: error.contextLimit, modelId } })
      })

/** Runs one agentic reply; the stream ends when the loop does. */
export const runAgent = (input: AgentStrategyInput, run: AgentRun): Stream.Stream<GenerationChunk, GenerationFailed> =>
  Stream.callback<GenerationChunk, GenerationFailed>((queue) =>
    Effect.gen(function* () {
      const { request, generation, rolloutId, output, providers } = input
      const { plan, tools, writer } = run
      const execution = yield* executionRegistry
      const model = generation.model!
      const registry = yield* Effect.serviceOption(ProviderRegistry)
      const target = {
        ...model,
        provider: Option.isSome(registry) ? registry.value.kinds.get(model.kind)?.piProvider : undefined
      }
      const services = yield* Effect.context<never>()
      const runFork = Effect.runForkWith(services)
      const runPromise = Effect.runPromiseWith(services)
      // A turn that may call tools can't be prefilled (spec/AGENTIC.md §3.2).
      const resolved = yield* input.resolveImages({ ...generation.request, prefill: null })
      const basePrefix = providerRequest(resolved, model)
      const prefix = run.checkpoints?.length
        ? { ...basePrefix, breakpoints: [...new Set([...basePrefix.breakpoints, ...run.checkpoints])] }
        : basePrefix
      /** The most requests this reply makes (`AgentPlan.turnCap`); a workshop has no cap. */
      const cap = plan.turnCap ?? Number.POSITIVE_INFINITY
      const sends = plan.contract !== "final_text"
      const several = plan.contract === "several"
      let working = { slotId: request.slotId, versionId: request.versionId }
      const historical = run.resume?.historical ?? 0
      let sent: string | undefined
      /** The character passed (`no_reply`): the version is the silent line. */
      let passed = false
      const send = (message: string) => {
        if (sent !== undefined || passed) return false
        sent = message
        emit(message)
        return true
      }
      const pass = () => {
        if (sent !== undefined || passed) return false
        passed = true
        // Anything streamed meanwhile (the pass's own thinking stays as the version's reasoning).
        emit({ silent: true })
        return true
      }
      /** Under the send tool alone, text is never the reply (§3.2): it shows in Steps, not the body. */
      const sendOnly = plan.contract === "send_message"
      /** The pass, where the snapshot froze it beside the send tool. */
      const passDefinition = sendOnly ? run.offered?.find((t) => t.name === NO_REPLY) : undefined
      const passTool = passDefinition
        ? noReplyTool(passDefinition, { sent: () => sent !== undefined || passed, take: pass })
        : undefined
      /** The ask to send, as the preset words it or by default (§3.3). */
      const nudgeText = run.sendNudge ?? sendNudgeText(passTool !== undefined)
      /** Set when the nudges ran out: the version fails with the contract's message (§3.4). */
      let exhausted: GenerationFailed | undefined
      /** A nudge the next request answers, appended after the failed turn. */
      let pendingNudge: number | undefined
      const sendTool: AgentTool = several
        ? {
            ...(run.offered?.find((t) => t.name === SEND_MESSAGE) ?? severalMessageDefinition),
            parameters: sendMessageDefinition.parameters,
            executionMode: "sequential",
            execute: async (id, params, signal) => {
              const receipt = await runPromise(
                run.reader.RolloutReceipt({ userId: request.userId, rolloutId, toolCallId: id })
              )
              if (receipt !== null) {
                const previous = JSON.parse(receipt) as { postedVersionId: string }
                return { content: [{ type: "text", text: "Sent." }], details: { versionId: previous.postedVersionId } }
              }
              if (signal?.aborted)
                return { content: [{ type: "text", text: "Stopped." }], details: INTERRUPTED, isError: true }
              const message = (params as { message: string }).message
              emit(message)
              const next = await new Promise<{
                slotId: typeof request.slotId
                versionId: typeof request.versionId
                postedVersionId: typeof request.versionId
              }>((resolve, reject) => {
                const abort = () => reject(new Error("Stopped."))
                signal?.addEventListener("abort", abort, { once: true })
                emit({
                  post: {
                    rolloutId,
                    toolCallId: id,
                    resolve: (value) => {
                      signal?.removeEventListener("abort", abort)
                      resolve(value)
                    },
                    reject: (error) => {
                      signal?.removeEventListener("abort", abort)
                      reject(error)
                    }
                  }
                })
              })
              working = next
              return { content: [{ type: "text", text: "Sent." }], details: { versionId: next.postedVersionId } }
            }
          }
        : sendMessageTool(
            // What the snapshot froze, so a resume offers and reads the same tool.
            run.offered?.find((t) => t.name === SEND_MESSAGE) ?? sendMessageDefinition,
            { sent: () => sent !== undefined, take: send, passed: () => passed },
            (id, present) =>
              runPromise(declarePresence(context(id), present)).catch(() => "Who is present could not be saved.")
          )
      // A resume offers the definitions its snapshot froze, exactly as they were sent.
      const frozen = (run.offered ?? tools.map(frozenTool)).filter(
        (t) => t.name !== SEND_MESSAGE && t.name !== CALL_TOOL && t.name !== NO_REPLY
      )
      // Deferred tools (spec/TOOL-LOADING.md): declared from the first request where the wire API
      // declares them (Anthropic), else sent only at their load points (Responses). Without a wire
      // for this model they're all sent from the start, as before.
      const loadingWire = run.loadingWire
      const deferred = new Set(loadingWire ? frozen.filter((t) => t.deferred === true).map((t) => t.name) : [])
      const definition = (t: FrozenTool): Tool => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as Tool["parameters"]
      })
      let piTools: ReadonlyArray<Tool> = [
        ...frozen.filter((t) => !deferred.has(t.name)).map(definition),
        ...(sends ? [{ name: sendTool.name, description: sendTool.description, parameters: sendTool.parameters }] : []),
        ...(passTool
          ? [{ name: passTool.name, description: passTool.description, parameters: passTool.parameters }]
          : []),
        ...(loadingWire?.declaresDeferred ? frozen.filter((t) => deferred.has(t.name)).map(definition) : [])
      ]
      const dispatch = loadingWire?.dispatcher === true && deferred.size > 0
      if (dispatch) {
        const transport = run.offered?.find((t) => t.name === CALL_TOOL)
        piTools = [...piTools, transport ? definition(transport) : dispatcherDefinition]
      }
      const deferredDefinitions = frozen.filter((t) => deferred.has(t.name)).map(definition)
      const emit = (chunk: GenerationChunk) => void Queue.offerUnsafe(queue, chunk)
      if (several) emit({ several: true })

      /** The typed failure behind an `error` turn, for the version's failure class. */
      let failure: GenerationFailed | undefined
      const seed = run.resume?.transcript as ReadonlyArray<AgentMessage> | undefined
      const room = (model.context ?? 128_000) - generation.request.samplers.max_tokens
      let resultTurn = -1
      let resultTokens = 0
      const textTokens = (text: string) =>
        runPromise(
          run.reader.CountRolloutContext({
            model: JSON.stringify(model),
            request: JSON.stringify(generation.request),
            transcript: "[]",
            tools: "[]",
            text
          })
        )
      // A resumed run counts the requests it made before, so its turn cap still holds.
      let requests = seed?.slice(historical).filter((m) => m.role === "assistant").length ?? 0
      /** Text a stop cut off: the first request sends it as the reply's start, and its output goes on from it. */
      // Under the send tool alone, text is never the reply, so it's never carried on (Resume
      // writes the turn again with its tools, api/agent.ts): this only guards that.
      let continuation = plan.contract === "send_message" ? undefined : run.resume?.continuation
      /** What this turn streamed into the body: any output, and text in particular. */
      const body = { text: false, prose: false }
      let partialSavedAt = Date.now()
      const streamFn: StreamFn = (piModel, transcript, options) => {
        const events = createAssistantMessageEventStream()
        if (options?.signal?.aborted) {
          const message: AssistantMessage = {
            ...emptyAssistant(piModel),
            stopReason: "aborted",
            errorMessage: "Stopped."
          }
          events.push({ type: "error", reason: "aborted", error: message })
          events.end(message)
          return events
        }
        requests++
        const carried = continuation
        continuation = undefined
        const last = requests >= cap || carried !== undefined
        // Measured with thinking enabled: keeping declarations and forbidding calls preserves
        // Anthropic's signed prefix and cache. Other wires retain their existing cap shape.
        const finalRequest = Option.isSome(registry)
          ? registry.value.thinkingBindings
              .list()
              .find((b) => b.appliesTo({ kind: model.kind, api: model.api, model: model.key }))?.finalRequest
          : undefined
        const cappedWithTools = requests >= cap && finalRequest !== undefined
        const offerTools = !last || cappedWithTools
        // Another model's thinking isn't sent to this one (a resume on another model, §12.3).
        const suffix = forTarget(liveSuffix(transcript.messages), target)
        // Where each deferred tool was loaded, for the provider transform. A request sent without
        // tools (the cap's) has no load points either: its history can't name undeclared tools.
        const toolLoading =
          deferred.size > 0 && offerTools && !dispatch
            ? { api: model.api, deferred: deferredDefinitions, loads: loadPoints(suffix, deferred) }
            : undefined
        const requestSuffix = dispatch ? dispatcherMessages(suffix, deferredDefinitions) : suffix
        const wire = rolloutRequest(
          prefix,
          model.api,
          carried === undefined
            ? requestSuffix
            : [...requestSuffix, { ...emptyAssistant(piModel), content: [{ type: "text", text: carried }] }],
          offerTools ? piTools : undefined,
          {
            explicitTail: model.cacheBreakpoints === "explicit",
            replayReasoning: several || plan.continuity === "resume_previous",
            reasoningTarget: target,
            ...(dispatch &&
            (model.kind === "deepseek" || (model.kind === "openrouter" && model.key.startsWith("deepseek/")))
              ? { requireReasoning: true }
              : {})
          }
        )
        // Text streams into the body as it comes; a tool call in the same turn makes it an
        // intermediate step, and the body starts over (DESIGN §7.2: not the message).
        body.text = false
        body.prose = false
        let called = false
        let done: AssistantMessage | undefined
        let rawArguments: Readonly<Record<string, string>> | undefined
        let partial: AssistantMessage = {
          ...emptyAssistant(piModel),
          content: carried === undefined ? [] : [{ type: "text", text: carried }]
        }
        let saveTimer: ReturnType<typeof setTimeout> | undefined
        const fiber = runFork(
          providers
            .stream({
              userId: request.userId,
              connectionId: model.connectionId as ConnectionId,
              modelId: model.modelId as ModelId,
              context: wire.context,
              inspection: { request: generation.request, model, display: generation.inspection },
              options: {
                ...(prefix.cacheRetention ? { cacheRetention: prefix.cacheRetention } : {}),
                ...(request.outputBudget ? { outputBudget: request.outputBudget } : {}),
                ...(prefix.temperature !== undefined ? { temperature: prefix.temperature } : {}),
                ...(prefix.maxTokens !== undefined ? { maxTokens: prefix.maxTokens } : {}),
                ...(prefix.reasoning ? { reasoning: prefix.reasoning } : {}),
                sessionId: request.chatId,
                payload: cappedWithTools ? { ...wire.payload, ...finalRequest } : wire.payload,
                breakpoints: wire.breakpoints,
                ...(run.checkpoints?.length ? { preserveBreakpoints: true } : {}),
                ...(wire.stable ? { stable: wire.stable } : {}),
                ...(toolLoading ? { toolLoading } : {})
              },
              attribution: {
                purpose: input.purpose ?? "generation",
                chatId: request.chatId,
                rolloutId,
                versionId: working.versionId
              }
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "retrying" && event.notice) request.onNotice?.(event.notice)
                  else if (event.type === "waiting-cache") request.onWaitingCache?.(event.waiting)
                  else if (event.type === "done") {
                    done = event.message
                    rawArguments = event.toolArguments
                  } else if (event.type === "toolcall") {
                    const sending = sends && (event.name === SEND_MESSAGE || event.name === NO_REPLY) && !last
                    // Thinking before the message is the message's reasoning; text before any
                    // call, or thinking before another tool, was a step.
                    if (!called && (sending ? body.prose : body.text)) emit({ restart: true })
                    called = true
                    // Kept on a turn cut off after it, so a resume resamples rather than continues it.
                    partial = {
                      ...partial,
                      content: [
                        ...partial.content,
                        {
                          type: "toolCall",
                          id: `partial-${partial.content.length}`,
                          name: event.name,
                          arguments: (event.arguments ?? {}) as Record<string, never>
                        }
                      ]
                    }
                  } else if (event.type === "text" || event.type === "thinking") {
                    // Preserve the failed/aborted turn too; a stop must not replace its
                    // already visible text with an empty assistant in the transcript.
                    const previous = partial.content.at(-1)
                    const same = previous?.type === event.type
                    const block =
                      event.type === "text"
                        ? {
                            type: "text" as const,
                            text: (previous?.type === "text" ? previous.text : "") + event.delta
                          }
                        : {
                            type: "thinking" as const,
                            thinking: (previous?.type === "thinking" ? previous.thinking : "") + event.delta
                          }
                    partial = {
                      ...partial,
                      content: [...(same ? partial.content.slice(0, -1) : partial.content), block]
                    }
                    // At most every PARTIAL_SAVE_MS, and once more that long after a delta, so a
                    // stream that stalls and then dies with the app still leaves its text.
                    const due = partialSavedAt + PARTIAL_SAVE_MS - Date.now()
                    if (due <= 0) {
                      if (saveTimer !== undefined) clearTimeout(saveTimer)
                      saveTimer = undefined
                      partialSavedAt = Date.now()
                      savePartial(partial)
                    } else
                      saveTimer ??= setTimeout(() => {
                        saveTimer = undefined
                        partialSavedAt = Date.now()
                        savePartial(partial)
                      }, due)
                    const decoded = yield* output.decode(event)
                    if (Result.isFailure(decoded) || called) return
                    // Under the send tool alone, a turn's text isn't the reply: it shows in Steps
                    // once the turn ends (spec/REPLY-CONTRACT.md §3.2). The cap's answer is.
                    if (sendOnly && !last && typeof decoded.success === "string") return
                    body.text = true
                    if (typeof decoded.success === "string") body.prose = true
                    emit(decoded.success)
                  }
                })
              )
            )
        )
        events.push({ type: "start", partial: emptyAssistant(piModel) })
        const abort = () => runFork(Fiber.interrupt(fiber))
        options?.signal?.addEventListener("abort", abort, { once: true })
        fiber.addObserver((exit) => {
          options?.signal?.removeEventListener("abort", abort)
          if (saveTimer !== undefined) clearTimeout(saveTimer)
          saveTimer = undefined
          if (Exit.isSuccess(exit) && done && carried !== undefined) {
            // The reply goes on from the text cut off: one turn, as if it had never stopped.
            const at = done.content.findIndex((p) => p.type === "text")
            const content = done.content.slice()
            if (at < 0) content.unshift({ type: "text", text: carried })
            else content[at] = { type: "text", text: carried + (content[at] as { text: string }).text }
            done = { ...done, content }
          }
          if (Exit.isSuccess(exit) && done) {
            if (dispatch) done = resolveDispatch(done, frozen, loadedSet(agent.state.messages, deferred), rawArguments)
            const reason = done.stopReason === "toolUse" || done.stopReason === "length" ? done.stopReason : "stop"
            events.push({ type: "done", reason, message: done })
            events.end(done)
            return
          }
          const aborted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          if (Exit.isFailure(exit) && !aborted) {
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            failure =
              error === undefined
                ? new GenerationFailed({ class: "server", message: "The request failed unexpectedly." })
                : failedOf(error as ProviderError, model.modelId)
          } else if (!aborted) {
            failure = new GenerationFailed({ class: "server", message: "The provider returned no result." })
          }
          const message: AssistantMessage = {
            ...partial,
            stopReason: aborted ? "aborted" : "error",
            errorMessage: aborted ? "Stopped." : failure!.message
          }
          const canonical = dispatch
            ? resolveDispatch(message, frozen, loadedSet(agent.state.messages, deferred))
            : message
          events.push({ type: "error", reason: aborted ? "aborted" : "error", error: canonical })
          events.end(canonical)
        })
        return events
      }

      const workshopData = execution.chatKinds.get(run.kind ?? "")?.allowsOutside === true
      // What this chat kind admits: in a story, outside effects only of the classes it names
      // (an MCP server the user enabled there, spec/MCP.md §8.1).
      const outsideClasses = execution.chatKinds.get(run.kind ?? "")?.outsideClasses ?? []
      const admits = (effect: string) =>
        admitsEffect({ allowsOutside: run.allowsOutside === true, outsideClasses }, effect)
      const cache = new Map<string, unknown>()
      const deliveredContent = new WeakSet<object>()
      // The engine itself produces unknown-tool, schema and thrown-execution errors,
      // bypassing both the registered executor and its before/after hooks. Quote these
      // at completion, before the engine constructs its durable result message.
      const quoteRuntimeFailure = (result: AgentToolResult<unknown>, isError: boolean, call: string) => {
        if (!workshopData || !isError || deliveredContent.has(result.content)) return
        const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
        // Fixed refusals with syntax-constrained identifiers contain no retrieved prose.
        if (text === BAD_ARGS || /^Tool [a-zA-Z0-9_-]{1,150} not found$/.test(text)) return
        const full = toolData(text)
        const step =
          stepsOf(agent.state.messages, frozen, false)
            .filter((s) => s.kind === "tool")
            .findLastIndex((s) => s.id === call) + 1
        const recovery = `[Result shortened. read_run with message 0 and from_step=${Math.max(1, step)} recovers it; follow its page cursors for the rest.]`
        const sent =
          full.length > TOOL_RESULT_CHARS ? toolDataPage(full, { more: () => recovery }).text || recovery : full
        result.content = [{ type: "text", text: full }]
        if (sent !== full) result.details = { ...(result.details as object | null), sentText: sent }
        deliveredContent.add(result.content)
      }
      const context = (toolCallId: string) => ({
        ...(workshopData
          ? {
              formatResult: (text: string, frame?: string) => {
                const formatted = toolData(text, frame)
                cache.set(`tool-data:${toolCallId}`, formatted)
                return formatted
              }
            }
          : {}),
        cache,
        ...(run.onChanged ? { onChanged: run.onChanged } : {}),
        userId: request.userId,
        chatId: request.chatId,
        forkId: request.forkId ?? null,
        slotId: working.slotId,
        versionId: working.versionId,
        rolloutId,
        toolCallId,
        transcript: () => agent.state.messages,
        leafSlotId: generation.leafSlotId as import("@dreamspan/shared/chat.ts").SlotId | null,
        viewers: generation.viewers,
        speaker: generation.speaker ?? null,
        ...(request.storyAt === undefined ? {} : { storyAt: request.storyAt }),
        offer: {
          kind: run.kind ?? "",
          tools: frozen,
          loaded: loadedSet(agent.state.messages, deferred),
          cardSkills: run.cardSkills ?? []
        },
        reader: run.reader,
        // A subagent's tools start none of their own (spec/SUBAGENTS.md §6.1).
        ...(run.subagent
          ? {}
          : {
              subagentHost: {
                input,
                run,
                offered: frozen,
                show: (row: SubagentRow | null) => {
                  if (row) children.set(toolCallId, row)
                  else children.delete(toolCallId)
                  showSteps(false)
                }
              }
            }),
        vision: (generation.model as { readonly vision?: boolean } | null)?.vision === true,
        // Tools never reach what only the user may do: grants and approvals.
        writer: toolWriter(writer)
      })
      const prepareTool = (tool: RolloutTool<never>, toolCallId: string) =>
        Effect.gen(function* () {
          const hook = tool.snapshot
          if (!hook || cache.has(`snapshot:${hook.key}`)) return
          const ctx = context(toolCallId)
          yield* hook.prepare(ctx, generation.agentToolState?.[hook.key])
          cache.set(`snapshot:${hook.key}`, true)
        })
      /** Calls waiting for the user, with what each will do: shown in their steps. */
      const waiting = new Map<string, ApprovalPrompt>()
      /** The subagents `agent` calls started, as they run: shown in their calls' steps. */
      const children = new Map<string, SubagentRow>()
      const waitingChanged = (toolCallId: string, prompt: ApprovalPrompt | null) => {
        if (prompt) waiting.set(toolCallId, prompt)
        else waiting.delete(toolCallId)
        showSteps(false)
      }
      const agentTools: Array<AgentTool> = tools.map((tool) => ({
        name: tool.id,
        label: tool.label,
        description: tool.description,
        parameters: dispatch ? Type.Any() : tool.parameters,
        executionMode: "sequential",
        execute: async (toolCallId, params, signal) => {
          let invalidJSON = false
          if (dispatch) {
            const call = agent.state.messages
              .flatMap((m) =>
                m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall" && p.id === toolCallId) : []
              )
              .at(-1)
            const refusal = call?.type === "toolCall" ? dispatchRefusal(call) : undefined
            invalidJSON = refusal === BAD_ARGS
            const offered = frozen.find((t) => t.name === tool.id)
            if ((refusal && refusal !== BAD_ARGS) || !offered)
              return {
                content: [{ type: "text", text: refusal ?? BAD_ARGS }],
                details: null,
                isError: true
              }
          }
          // Dangling calls on resume execute directly, without pi-agent's beforeToolCall hook.
          if (!admits(tool.effect))
            return {
              content: [{ type: "text", text: "This chat does not allow tools with outside effects." }],
              details: null,
              isError: true
            }
          // A deferred tool runs only once a loading call made it callable; loading grants nothing,
          // so everything below applies to it exactly as to a tool sent from the start.
          if (deferred.has(tool.id) && !loadedSet(agent.state.messages, deferred).has(tool.id))
            return {
              content: [
                {
                  type: "text",
                  text: dispatch
                    ? missingTool(tool.id)
                    : `“${tool.id}” isn't loaded yet. Load it with tool_search or load_skill first.`
                }
              ],
              details: null,
              isError: true
            }
          const dangling = seed !== undefined && danglingCalls(seed).some((call) => call.id === toolCallId)
          // The capability's standing decides, asking the user first where it says so; without
          // a permit, a dangling call with outside effects may already have happened.
          const permitted: Effect.Effect<ToolOutput> = run.permit
            ? run
                .permit({
                  // A call-specific capability (a card's own skill) is checked as the tool's.
                  tool: (() => {
                    const capability = tool.capabilityFor?.(context(toolCallId), params as never)
                    return capability ? { ...tool, capability } : tool
                  })(),
                  context: context(toolCallId),
                  args: params,
                  ...(() => {
                    const grantTarget = tool.approvalTarget?.(context(toolCallId), params as never)
                    return grantTarget ? { grantTarget } : {}
                  })(),
                  dangling,
                  ...(dispatch
                    ? {
                        unavailableText: missingTool(tool.id),
                        validate: () =>
                          !invalidJSON &&
                          fitsTool(
                            frozen.find((t) => t.name === tool.id)!,
                            params
                          )
                            ? undefined
                            : BAD_ARGS
                      }
                    : {}),
                  onWaiting: (prompt) => waitingChanged(toolCallId, prompt)
                })
                .pipe(
                  Effect.flatMap((permit) =>
                    permit.run
                      ? tool.execute(
                          {
                            ...context(toolCallId),
                            ...(permit.approvalDigest ? { approvalDigest: permit.approvalDigest } : {})
                          },
                          params as never
                        )
                      : Effect.succeed<ToolOutput>({ text: permit.text, isError: true })
                  )
                )
            : dispatch &&
                (invalidJSON ||
                  !fitsTool(
                    frozen.find((t) => t.name === tool.id)!,
                    params
                  ))
              ? Effect.succeed<ToolOutput>({ text: BAD_ARGS, isError: true })
              : outsideEffect(tool.effect) && dangling
                ? Effect.succeed<ToolOutput>({ text: UNCERTAIN_EFFECT, isError: true })
                : tool.execute(context(toolCallId), params as never)
          // A committed call's receipt takes precedence over validation against its own
          // changed state (a note may now exist, or its old passage may already be gone).
          const execute =
            tool.effect !== "read"
              ? run.reader
                  .RolloutToolReceipt({ userId: request.userId, rolloutId, toolCallId })
                  .pipe(
                    Effect.flatMap((receipt) =>
                      receipt !== null ? Effect.succeed<ToolOutput>({ ...receipt, replayed: true }) : permitted
                    )
                  )
              : permitted
          // A stop interrupts the tool; its result says so, and a resume runs the call again.
          const exit = await runPromise(Effect.exit(prepareTool(tool, toolCallId).pipe(Effect.andThen(execute))), {
            signal
          }).catch(() => undefined)
          if (signal?.aborted || exit === undefined || Exit.isFailure(exit))
            return {
              content: [{ type: "text", text: signal?.aborted ? "Stopped." : "The tool failed." }],
              details: signal?.aborted ? INTERRUPTED : null,
              isError: true
            }
          const raw = exit.value
          // Skills are the intentionally approved instruction channel; loading returns app-owned
          // frozen definitions. Every other fresh workshop result crosses the same data boundary.
          // An MCP server's result is quoted data in a story too (spec/MCP.md §9).
          const serverData = workshopData || tool.mcp !== undefined
          const quote =
            serverData &&
            !(["tool_search", "load_skill"].includes(tool.id) && !raw.isError && !raw.dataOnly) &&
            !raw.replayed &&
            ![BAD_ARGS, missingTool(tool.id)].includes(raw.text)
          const result =
            quote && !raw.dataOnly && cache.get(`tool-data:${toolCallId}`) !== raw.text
              ? { ...raw, text: toolData(raw.text, raw.frame), dataOnly: true as const }
              : raw
          // A story's MCP call keeps its receipt too, so Resume answers from it (spec/MCP.md §8.2).
          if (tool.effect !== "read" && (run.allowsOutside === true || tool.mcp !== undefined)) {
            await runPromise(
              writer.RecordRolloutEffects({
                userId: request.userId,
                rolloutId,
                toolCallId,
                result: result.text,
                isError: result.isError === true,
                ...(result.effects ? { effects: result.effects } : {})
              })
            )
          }
          if (tool.effect === "chat_state" && !result.isError) run.onState?.()
          // Keep the complete original in the transcript. Only its model projection is bounded.
          const fullText = serverData ? result.text : budgetResult(result.text)
          const stepNumber =
            stepsOf(agent.state.messages, frozen, false)
              .filter((step) => step.kind === "tool")
              .findLastIndex((step) => step.id === toolCallId) + 1
          const recovery = `[Result shortened. read_run with message 0 and from_step=${Math.max(1, stepNumber)} recovers it; follow its page cursors for the rest.]`
          // A story has no read_run: its server results are paged by read_result, this run's only.
          const storyMore = (end: number) =>
            /^[A-Za-z0-9_.:-]{1,128}$/.test(toolCallId)
              ? `[Result shortened. read_result with call "${toolCallId}" and offset=${end} continues it.]`
              : `[Result shortened. read_result with this call's id and offset=${end} continues it.]`
          // Page the original, not the envelope this wrapped it in: paging the envelope quoted it twice.
          const pageSource = result !== raw ? raw.text : fullText
          let sentText =
            quote && fullText.length > TOOL_RESULT_CHARS
              ? toolDataPage(pageSource, { frame: raw.frame, more: workshopData ? () => recovery : storyMore }).text ||
                (workshopData ? recovery : storyMore(0))
              : fullText
          if (execution.chatKinds.get(run.kind ?? "")?.summaryTranscript && !raw.replayed) {
            const turn = agent.state.messages.findLastIndex((m) => m.role === "assistant")
            if (turn !== resultTurn) {
              resultTurn = turn
              resultTokens = 0
            }
            const quota = Math.max(128, Math.floor(room / 4))
            const remaining = Math.max(0, quota - resultTokens)
            if ((await textTokens(sentText)) > remaining) {
              let marker = `\n${recovery}`
              if ((await textTokens(marker)) > remaining) marker = ""
              const page = (limit: number) =>
                quote
                  ? toolDataPage(pageSource, { limit, frame: raw.frame, more: () => recovery }).text
                  : fullText.slice(0, limit) + marker
              let lo = 0,
                hi = Math.min(TOOL_RESULT_CHARS, sentText.length)
              while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2)
                if ((await textTokens(page(mid))) <= remaining) lo = mid
                else hi = mid - 1
              }
              // Always retain the recovery direction, even when the payload quota is spent.
              // This small app-owned framing cost may exceed the aggregate payload quota.
              sentText = page(lo) || recovery
            }
            resultTokens += await textTokens(sentText)
          }
          const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
            { type: "text" as const, text: fullText },
            // A server's images, for a model that takes them (spec/MCP.md §9).
            ...(result.images ?? []).map((image) => ({ type: "image" as const, ...image }))
          ]
          deliveredContent.add(content)
          return {
            content,
            // What a loading call loaded is part of the transcript: replay derives the loaded set from it.
            details:
              sentText !== fullText || result.loaded?.length || result.presentation || result.subagent
                ? {
                    ...(sentText !== fullText ? { sentText } : {}),
                    ...(result.loaded?.length && !result.isError ? { loaded: [...result.loaded] } : {}),
                    ...(result.presentation ? { presentation: result.presentation } : {}),
                    // The subagent this call started, kept with its result (never sent to a model).
                    ...(result.subagent ? { subagent: result.subagent } : {})
                  }
                : null,
            ...(result.isError ? { isError: true } : {})
          }
        }
      }))

      // Invalid envelopes have no executor. Kept only to return the same refusal as an unknown tool.
      if (dispatch)
        agentTools.push({
          ...dispatcherDefinition,
          parameters: Type.Any(),
          label: CALL_TOOL,
          execute: async () => ({
            content: [{ type: "text", text: missingTool(CALL_TOOL) }],
            details: null,
            isError: true
          })
        })
      if (passTool)
        agentTools.push(
          dispatch
            ? {
                ...passTool,
                parameters: Type.Any(),
                execute: async (id, params, signal) => {
                  const call = agent.state.messages
                    .flatMap((m) =>
                      m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall" && p.id === id) : []
                    )
                    .at(-1)
                  const refusal = call?.type === "toolCall" ? dispatchRefusal(call) : undefined
                  if (refusal || !fitsTool(passTool, params))
                    return {
                      content: [{ type: "text" as const, text: refusal ?? BAD_ARGS }],
                      details: null,
                      isError: true
                    }
                  return passTool.execute(id, params as never, signal)
                }
              }
            : passTool
        )
      if (sends)
        agentTools.push(
          dispatch
            ? {
                ...sendTool,
                parameters: Type.Any(),
                execute: async (id, params, signal) => {
                  const call = agent.state.messages
                    .flatMap((m) =>
                      m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall" && p.id === id) : []
                    )
                    .at(-1)
                  const refusal = call?.type === "toolCall" ? dispatchRefusal(call) : undefined
                  if (refusal || !fitsTool(sendTool, params))
                    return {
                      content: [{ type: "text" as const, text: refusal ?? BAD_ARGS }],
                      details: null,
                      isError: true
                    }
                  return sendTool.execute(id, params as never, signal)
                }
              }
            : sendTool
        )
      /** The asks to send so far: counted from the transcript, so a resumed run goes on with the count (§3.3). */
      let nudges = nudgesIn(seed?.slice(historical) ?? [])
      const agent: Agent = new Agent({
        initialState: {
          model: {
            id: model.key,
            name: model.key,
            api: model.api,
            provider: model.kind,
            baseUrl: "",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: model.context ?? 0,
            maxTokens: 0
          } as unknown as Model<Api>,
          thinkingLevel: "off",
          tools: agentTools,
          messages: seed
            ? sendOnly
              ? sendOnlyTranscript(seed)
              : seed.slice()
            : [
                {
                  role: "rpRequest",
                  timestamp: Date.now(),
                  ...(sendOnly ? { contract: "send_message" as const } : {})
                },
                ...(cap <= 1
                  ? [
                      {
                        role: "rpHarness" as const,
                        content: run.subagent?.writeNow ?? WRITE_NOW,
                        timestamp: Date.now()
                      }
                    ]
                  : [])
              ]
        },
        prepareRequest: async ({ context }, signal) => {
          if (!execution.chatKinds.get(run.kind ?? "")?.summaryTranscript || run.subagent) return
          const compactor = execution.runCompactors.get("workshop")
          if (!compactor) throw new Error("Workshop summaries are unavailable.")
          try {
            const compacted = await runPromise(
              compactor.compact({
                reader: run.reader,
                providers,
                request,
                rolloutId,
                model,
                prefix: generation.request,
                recentPrefix: run.recentPrefix,
                messages: context.messages,
                tools: countedTools(
                  frozen,
                  deferred,
                  context.messages,
                  dispatch
                    ? (run.offered?.find((t) => t.name === CALL_TOOL) ?? {
                        ...dispatcherDefinition,
                        label: "Called a loaded tool",
                        effect: "read"
                      })
                    : null
                ).concat(sends ? [sendTool as unknown as FrozenTool] : []),
                reserve: generation.request.samplers.max_tokens,
                leafSlotId: generation.leafSlotId as import("@dreamspan/shared/chat.ts").SlotId | null
              }),
              { signal }
            )
            if (JSON.stringify(compacted) !== JSON.stringify(context.messages)) {
              agent.state.messages = [...compacted]
              if (!(await flush())) throw new Error("The summary could not be saved.")
              run.onState?.()
              return { context: { ...context, messages: [...compacted] } }
            }
          } catch (error) {
            failure =
              error instanceof GenerationFailed
                ? error
                : new GenerationFailed({
                    class: "server",
                    message: "The workshop couldn't save its summary. Resume to try again."
                  })
            throw error
          }
        },
        convertToLlm: async (messages) => {
          if (!messages.some((m) => m.role === "rpUser")) return liveSuffix(messages)
          const hydrated: Array<AgentMessage> = []
          for (const message of messages) {
            if (message.role !== "rpUser") {
              hydrated.push(message)
              continue
            }
            const resolved = await runPromise(
              input.resolveImages({ ...generation.request, prefill: null, messages: [message.message] })
            )
            if (model.api === "openai-completions") {
              const user = resolved.messages[0]!
              const images = (user.images ?? []).flatMap((image) =>
                image.data && image.mimeType
                  ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }]
                  : []
              )
              hydrated.push({
                role: "user",
                content: images.length ? [{ type: "text", text: user.content }, ...images] : user.content,
                timestamp: message.timestamp,
                ...(user.name ? { name: user.name } : {})
              } as AgentMessage)
            } else hydrated.push(providerRequest(resolved, model).context.messages[0]!)
          }
          return liveSuffix(hydrated)
        },
        streamFn,
        toolExecution: "sequential",
        beforeToolCall: async ({ toolCall }) => {
          const refusal = dispatchRefusal(toolCall)
          if (refusal && (!dispatch || refusal !== BAD_ARGS || toolCall.name === SEND_MESSAGE))
            return { block: true, reason: refusal }
          const tool = tools.find((entry) => entry.id === toolCall.name)
          if (tool && !admits(tool.effect))
            return { block: true, reason: "This chat does not allow tools with outside effects." }
          if (requests >= cap) return { block: true, reason: "The last model request of this reply can't use tools." }
          if (!several && (sent !== undefined || passed))
            return { block: true, reason: "The reply has already been sent." }
          // A process kill after an effect commits must leave its call ID durable,
          // so recovery can replay the receipt instead of sampling a duplicate call.
          const saved = await flush()
          return saved ? undefined : { block: true, reason: "The tool call could not be saved. Go on without it." }
        },
        // One message a turn (DESIGN §7.2): a sent message, or a pass, ends the loop. Under
        // `send_message` alone, a turn that ends in plain text is asked to send it, as reference-harness's
        // forced completion (spec/REPLY-CONTRACT.md §3.3), at most SEND_NUDGES times a run; then the
        // reply fails (§3.4). A failed or stopped turn is never nudged: it fails or stops the reply.
        finishTurn: ({ message }, signal) => {
          // The cap's request is the last, whatever it asked for; a stop ends the loop here.
          if (sent !== undefined || passed || requests >= cap || signal?.aborted) return { action: "end" }
          const plain = !message.content.some((p) => p.type === "toolCall")
          const failed = message.stopReason === "error" || message.stopReason === "aborted"
          if (plain && !failed && sendOnly) {
            if (body.text) emit({ restart: true })
            // The cap's "write now" takes precedence, even over running out: its answer is the reply (§3.5).
            if (requests >= cap - 1) return { action: "continue" }
            if (nudges >= SEND_NUDGES) {
              // Every plain turn of the reply: one before each nudge, this one, and those Resume cut.
              exhausted = contractFailure(nudges + 1 + cutAnswersIn(agent.state.messages.slice(historical)))
              return { action: "end" }
            }
            pendingNudge = ++nudges
            return { action: "continue" }
          }
          return undefined
        },
        // The last request is made without tools, after the app's "write now".
        prepareNextTurnWithContext: () => {
          if (requests === cap - 1) {
            pendingNudge = undefined
            return {
              messages: [{ role: "rpHarness", content: run.subagent?.writeNow ?? WRITE_NOW, timestamp: Date.now() }]
            }
          }
          if (pendingNudge === undefined) return undefined
          const nudge = pendingNudge
          pendingNudge = undefined
          return { messages: [{ role: "rpHarness", content: nudgeText, nudge, timestamp: Date.now() }] }
        }
      })

      // The transcript is the agent's whole state, flushed in order after each turn and at the
      // end (reference-harness session-capture). A failed write is logged, never fatal.
      let flushing: Promise<void> = Promise.resolve()
      const flush = () => {
        const messages = agent.state.messages.slice()
        const saving = flushing.then(() =>
          runPromise(
            writer
              .SaveRolloutTranscript({
                userId: request.userId,
                rolloutId,
                transcript: JSON.stringify(messages),
                steps: countSteps(messages)
              })
              .pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`saving rollout ${rolloutId}'s transcript failed`, cause).pipe(Effect.as(false))
                )
              )
          )
        )
        flushing = saving.then(() => undefined)
        return saving
      }
      /** The turn being streamed, saved after the turns before it, as a stop would leave it. */
      const savePartial = (turn: AssistantMessage) => {
        const messages = [
          ...agent.state.messages,
          { ...turn, stopReason: "aborted" as const, errorMessage: "The app stopped while this turn was written." }
        ]
        flushing = flushing.then(() =>
          runPromise(
            writer
              .SaveRolloutTranscript({
                userId: request.userId,
                rolloutId,
                transcript: JSON.stringify(messages),
                steps: countSteps(agent.state.messages)
              })
              .pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning(`saving rollout ${rolloutId}'s turn so far failed`, cause)
                )
              )
          )
        )
      }
      const shown = new Map<string, string>()
      const showSteps = (final: boolean) => {
        const posted = several
          ? agent.state.messages
              .slice(historical)
              .flatMap((m) =>
                m.role === "toolResult" &&
                m.toolName === SEND_MESSAGE &&
                !m.isError &&
                (m.details as { versionId?: string } | null)?.versionId
                  ? [(m.details as { versionId: typeof request.versionId }).versionId]
                  : []
              )
          : []
        for (const id of [...new Set([...posted, working.versionId])]) {
          // A call waiting for the user shows as waiting, with what it asks.
          const steps = stepsOf(agent.state.messages, frozen, final, several ? id : undefined).map((step) => {
            const approval = step.kind === "tool" ? waiting.get(step.id) : undefined
            const child = step.kind === "tool" ? children.get(step.id) : undefined
            const shown = child && step.kind === "tool" ? { ...step, subagent: child } : step
            return approval && shown.kind === "tool"
              ? { ...shown, ...approval.presentation, status: "waiting" as const, approval }
              : shown
          })
          const json = JSON.stringify(steps)
          if (json === shown.get(id)) continue
          shown.set(id, json)
          emit({ steps, ...(several ? { versionId: id } : {}) })
        }
      }
      agent.subscribe((event) => {
        if (event.type === "tool_execution_end") quoteRuntimeFailure(event.result, event.isError, event.toolCallId)
        if (event.type === "turn_end" || event.type === "agent_end")
          void flush().then(() => showSteps(event.type === "agent_end"))
        if (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "turn_end")
          showSteps(false)
      })

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          agent.abort()
          await agent.waitForIdle()
          await flush()
        })
      )
      // A resumed run first runs the calls it had made without results (receipts make a
      // chat-state call already written answer as it did), then goes on as the loop would.
      // A terminal send may have been flushed before the process died, while the version's
      // completion was not. Restore it through the ordinary output pipeline without a new turn.
      if (sends && seed && !several) {
        const delivered = new Set(
          seed
            .slice(historical)
            .flatMap((m) =>
              m.role === "toolResult" && m.toolName === SEND_MESSAGE && !m.isError ? [m.toolCallId] : []
            )
        )
        for (const message of seed.slice(historical)) {
          if (message.role !== "assistant") continue
          for (const part of message.content)
            if (
              part.type === "toolCall" &&
              part.name === SEND_MESSAGE &&
              delivered.has(part.id) &&
              typeof part.arguments.message === "string"
            )
              send(part.arguments.message)
        }
        // A pass saved before the process died is the reply's ending too.
        if (
          sent === undefined &&
          passTool &&
          seed.slice(historical).some((m) => m.role === "toolResult" && m.toolName === NO_REPLY && !m.isError)
        )
          pass()
      }
      const dangling = sent === undefined && !passed ? danglingCalls(agent.state.messages) : []
      if (dangling.length > 0) {
        const signal = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => signal.abort()))
        for (const call of dangling) {
          const tool = agentTools.find((t) => t.name === call.name)
          // A completed write is evidence even after its tool was removed. Reading its
          // receipt never grants permission to execute a new call.
          const receipt =
            call.name === SEND_MESSAGE
              ? null
              : yield* run.reader
                  .RolloutToolReceipt({
                    userId: request.userId,
                    rolloutId,
                    toolCallId: call.id
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new GenerationFailed({
                          class: "server",
                          message: "The app couldn't check whether this tool already finished. Resume to try again."
                        })
                    )
                  )
          const refusal = dispatchRefusal(call)
          const result = receipt
            ? {
                content: [{ type: "text" as const, text: workshopData ? receipt.text : budgetResult(receipt.text) }],
                details: null,
                isError: receipt.isError
              }
            : refusal && (!dispatch || refusal !== BAD_ARGS)
              ? { content: [{ type: "text" as const, text: refusal }], details: null, isError: true }
              : tool
                ? yield* Effect.promise(() =>
                    tool.execute(call.id, call.arguments as never, signal.signal).catch((error: unknown) => ({
                      content: [
                        { type: "text" as const, text: error instanceof Error ? error.message : String(error) }
                      ],
                      details: null,
                      isError: true
                    }))
                  )
                : {
                    content: [{ type: "text" as const, text: `There's no tool “${call.name}”.` }],
                    details: null,
                    isError: true
                  }
          if (!receipt) quoteRuntimeFailure(result, result.isError === true, call.id)
          agent.state.messages = [
            ...agent.state.messages,
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: result.content,
              details: result.details,
              isError: result.isError === true,
              timestamp: Date.now()
            }
          ]
        }
        yield* Effect.promise(() => flush())
      }
      showSteps(false)
      // The call carried on was the message itself (or the pass).
      if (sent !== undefined || passed) {
        yield* Effect.promise(() => flushing)
        showSteps(true)
        return yield* Queue.end(queue)
      }
      // The tail is the frozen request (or the kept transcript): the loop sends it, with no user turn of its own.
      const started = yield* Effect.tryPromise(() => agent.continue()).pipe(Effect.option)
      if (Option.isNone(started) && !failure)
        failure = new GenerationFailed({ class: "server", message: "The agent couldn't start." })
      if (Option.isNone(started)) return yield* Queue.fail(queue, failure!)
      yield* Effect.promise(() => flushing)
      showSteps(true)
      // The nudges ran out: the reply fails visibly, its stray text kept in its steps (§3.4).
      if (exhausted) return yield* Queue.fail(queue, exhausted)
      const final = agent.state.messages.at(-1)
      if (final?.role === "assistant" && (final.stopReason === "error" || final.stopReason === "aborted")) {
        return yield* Queue.fail(
          queue,
          failure ?? new GenerationFailed({ class: "server", message: final.errorMessage ?? "The reply failed." })
        )
      }
      yield* Queue.end(queue)
    })
  )
