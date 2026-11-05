// The agent reply strategy (spec/AGENTIC.md §3): a pi-agent-core loop over the frozen request.
// The assembler built the context once; each provider request is that prefix plus the
// rollout's own transcript (wire.ts), sent through the provider layer so its ledger, retries,
// proxy, transforms and inspector capture apply. The loop's output is the same chunk stream a
// plain reply yields, so reply parsers, live rewrites and the version's persistence treat both
// alike (DESIGN §7.2: one commit pipeline). The transcript is flushed as each turn ends.
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core"
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Tool,
  Type
} from "@earendil-works/pi-ai"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Cause, Effect, Exit, Fiber, Option, Queue, Result, Stream } from "effect"
import type { AssembledRequest, Generation } from "../assembler/types.ts"
import { providerRequest } from "../assembler/wire.ts"
import type { Reader, Writer } from "../db/Database.ts"
import { GenerationFailed, type GenerationChunk, type GenerationRequest } from "../chat/Generator.ts"
import type { ReplyOutputStrategy } from "../chat/replyOutput.ts"
import type { Providers, ProviderError } from "../providers/Providers.ts"
import type { AgentPlan } from "./modes.ts"
import { countSteps, SEND_MESSAGE, stepsOf } from "./steps.ts"
import { budgetResult, frozenTool, type RolloutTool } from "./tools.ts"
import { rolloutRequest } from "./wire.ts"

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    /** Stands for the frozen assembled request: everything the model is sent before its own turns. */
    rpRequest: { readonly role: "rpRequest"; readonly timestamp: number }
    /** A message the app adds (the turn cap's "write now"), sent as the user's and labelled as the app's. */
    rpHarness: { readonly role: "rpHarness"; readonly content: string; readonly timestamp: number }
  }
}

/** What an agent turn needs beyond a plain reply's. */
export interface AgentRun {
  readonly plan: AgentPlan
  readonly mode: string
  readonly tools: ReadonlyArray<RolloutTool<never>>
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
}

export interface AgentStrategyInput {
  readonly resolveImages: (input: AssembledRequest) => Effect.Effect<AssembledRequest, GenerationFailed>
  readonly request: GenerationRequest
  readonly generation: Generation
  readonly rolloutId: string
  readonly output: ReturnType<ReplyOutputStrategy["create"]>
  readonly providers: Providers["Service"]
  readonly agent?: AgentRun
}

export const WRITE_NOW = "Write the reply now."

export const SEND_NUDGE = "Send your reply with send_message."

/** The contract's tool (DESIGN §7.2): the message, ending the turn; one a turn. */
const sendMessageTool = (onSend: (message: string) => boolean): AgentTool => ({
  name: SEND_MESSAGE,
  label: "Sent the message",
  description:
    "Sends your reply: the next message of the story, written as it should appear. Call it once, when the reply is ready; it ends your turn.",
  parameters: Type.Object({ message: Type.String({ description: "The message, exactly as it should appear." }) }),
  executionMode: "sequential",
  execute: async (_id, params) => {
    const sent = onSend((params as { message: string }).message)
    return {
      content: [{ type: "text", text: sent ? "Sent." : "Only one message a turn: the first one was sent." }],
      details: null,
      ...(sent ? { terminate: true } : { isError: true })
    }
  }
})

/** The messages the model sees after the frozen request: its turns, tool results and the app's notes. */
export const liveSuffix = (messages: ReadonlyArray<AgentMessage | Message>): Array<Message> => {
  const start = messages.findIndex((m) => m.role === "rpRequest")
  return messages.slice(start + 1).flatMap((m): Array<Message> => {
    if (m.role === "rpHarness") return [{ role: "user", content: m.content, timestamp: m.timestamp }]
    if (m.role === "assistant" || m.role === "toolResult" || m.role === "user") return [m]
    return []
  })
}

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
      const model = generation.model!
      const services = yield* Effect.context<never>()
      const runFork = Effect.runForkWith(services)
      const runPromise = Effect.runPromiseWith(services)
      // A turn that may call tools can't be prefilled (spec/AGENTIC.md §3.2).
      const resolved = yield* input.resolveImages({ ...generation.request, prefill: null })
      const prefix = providerRequest(resolved, model)
      const sends = plan.contract !== "final_text"
      let sent: string | undefined
      const sendTool = sendMessageTool((message) => {
        if (sent !== undefined) return false
        sent = message
        return true
      })
      const piTools: ReadonlyArray<Tool> = [
        ...tools.map((t) => ({ name: t.id, description: t.description, parameters: t.parameters })),
        ...(sends ? [{ name: sendTool.name, description: sendTool.description, parameters: sendTool.parameters }] : [])
      ]
      const frozen = tools.map(frozenTool)
      const emit = (chunk: GenerationChunk) => void Queue.offerUnsafe(queue, chunk)

      /** The typed failure behind an `error` turn, for the version's failure class. */
      let failure: GenerationFailed | undefined
      let requests = 0
      /** What this turn streamed into the body: any output, and text in particular. */
      const body = { text: false, prose: false }
      /** Whether the message `send_message` carries went to the body (it does once). */
      let announced = false

      const streamFn: StreamFn = (piModel, transcript, options) => {
        const events = createAssistantMessageEventStream()
        requests++
        const last = requests >= plan.turnCap
        const wire = rolloutRequest(prefix, model.api, liveSuffix(transcript.messages), last ? undefined : piTools, {
          explicitTail: model.cacheBreakpoints === "explicit"
        })
        // Text streams into the body as it comes; a tool call in the same turn makes it an
        // intermediate step, and the body starts over (DESIGN §7.2: not the message).
        body.text = false
        body.prose = false
        let called = false
        let done: AssistantMessage | undefined
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
                ...(prefix.temperature !== undefined ? { temperature: prefix.temperature } : {}),
                ...(prefix.maxTokens !== undefined ? { maxTokens: prefix.maxTokens } : {}),
                ...(prefix.reasoning ? { reasoning: prefix.reasoning } : {}),
                sessionId: request.chatId,
                payload: wire.payload,
                breakpoints: wire.breakpoints
              },
              attribution: { purpose: "generation", chatId: request.chatId, rolloutId, versionId: request.versionId }
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "waiting-cache") request.onWaitingCache?.(event.waiting)
                  else if (event.type === "done") done = event.message
                  else if (event.type === "toolcall") {
                    const sends = event.name === SEND_MESSAGE
                    // Thinking before the message is the message's reasoning; text before any
                    // call, or thinking before another tool, was a step.
                    if (!called && (sends ? body.prose : body.text)) emit({ restart: true })
                    called = true
                    // The message arrives with its call: the provider layer doesn't stream arguments.
                    const message = (event.arguments as { message?: unknown } | null)?.message
                    if (sends && typeof message === "string" && !announced) {
                      announced = true
                      emit(message)
                    }
                  } else if (event.type === "text" || event.type === "thinking") {
                    const decoded = yield* output.decode(event)
                    if (Result.isFailure(decoded) || called) return
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
          if (Exit.isSuccess(exit) && done) {
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
            ...emptyAssistant(piModel),
            stopReason: aborted ? "aborted" : "error",
            errorMessage: aborted ? "Stopped." : failure!.message
          }
          events.push({ type: "error", reason: aborted ? "aborted" : "error", error: message })
          events.end(message)
        })
        return events
      }

      const context = (toolCallId: string) => ({
        userId: request.userId,
        chatId: request.chatId,
        forkId: request.forkId ?? null,
        slotId: request.slotId,
        versionId: request.versionId,
        rolloutId,
        toolCallId,
        leafSlotId: generation.leafSlotId as import("@rp/shared/chat.ts").SlotId | null,
        reader: run.reader,
        writer
      })
      const agentTools: Array<AgentTool> = tools.map((tool) => ({
        name: tool.id,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        executionMode: "sequential",
        execute: async (toolCallId, params) => {
          const result = await runPromise(tool.execute(context(toolCallId), params as never))
          return {
            content: [{ type: "text", text: budgetResult(result.text) }],
            details: null,
            ...(result.isError ? { isError: true } : {})
          }
        }
      }))

      if (sends) agentTools.push(sendTool)
      let nudged = false
      let nudgeSent = false
      const agent = new Agent({
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
          messages: [{ role: "rpRequest", timestamp: Date.now() }]
        },
        convertToLlm: (messages) => liveSuffix(messages),
        streamFn,
        toolExecution: "sequential",
        // One message a turn (DESIGN §7.2): a sent message ends the loop. Under `send_message`
        // alone, a reply written as plain text is asked once to be sent; then it's taken as it is.
        finishTurn: ({ message }) => {
          // The cap's request is the last, whatever it asked for.
          if (sent !== undefined || requests >= plan.turnCap) return { action: "end" }
          const plain = !message.content.some((p) => p.type === "toolCall")
          const failed = message.stopReason === "error" || message.stopReason === "aborted"
          if (plain && !failed && plan.contract === "send_message" && !nudged && requests < plan.turnCap) {
            nudged = true
            if (body.text) emit({ restart: true })
            return { action: "continue" }
          }
          return undefined
        },
        // The last request is made without tools, after the app's "write now".
        prepareNextTurnWithContext: () =>
          nudged && !nudgeSent
            ? ((nudgeSent = true), { messages: [{ role: "rpHarness", content: SEND_NUDGE, timestamp: Date.now() }] })
            : requests === plan.turnCap - 1
              ? { messages: [{ role: "rpHarness", content: WRITE_NOW, timestamp: Date.now() }] }
              : undefined
      })

      // The transcript is the agent's whole state, flushed in order after each turn and at the
      // end (reference-harness session-capture). A failed write is logged, never fatal.
      let flushing: Promise<void> = Promise.resolve()
      const flush = () => {
        const messages = agent.state.messages.slice()
        flushing = flushing.then(() =>
          runPromise(
            writer
              .SaveRolloutTranscript({
                userId: request.userId,
                rolloutId,
                transcript: JSON.stringify(messages),
                steps: countSteps(messages)
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`saving rollout ${rolloutId}'s transcript failed`, cause)
                )
              )
          )
        )
        return flushing
      }
      let shown = "[]"
      const showSteps = (final: boolean) => {
        const steps = stepsOf(agent.state.messages, frozen, final)
        const json = JSON.stringify(steps)
        if (json === shown) return
        shown = json
        emit({ steps })
      }
      agent.subscribe((event) => {
        if (event.type === "turn_end" || event.type === "agent_end") void flush()
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
      // The tail is the frozen request: the loop sends it, with no user turn of its own.
      const started = yield* Effect.tryPromise(() => agent.continue()).pipe(Effect.option)
      if (Option.isNone(started) && !failure)
        failure = new GenerationFailed({ class: "server", message: "The agent couldn't start." })
      if (Option.isNone(started)) return yield* Queue.fail(queue, failure!)
      yield* Effect.promise(() => flushing)
      showSteps(true)
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
