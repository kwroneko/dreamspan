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
  type Tool
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
import { danglingCalls } from "./resume.ts"
import {
  budgetResult,
  type FrozenTool,
  frozenTool,
  sendMessageDefinition,
  type RolloutTool,
  type ToolOutput
} from "./tools.ts"
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
  readonly allowsOutside?: boolean
  readonly plan: AgentPlan
  readonly mode: string
  readonly tools: ReadonlyArray<RolloutTool<never>>
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly onState?: () => void
  /** The tool definitions to offer as a snapshot froze them (a resume); absent: `tools`' own. */
  readonly offered?: ReadonlyArray<FrozenTool>
  /** Carrying on a stopped run (resume.ts): its kept transcript, and text cut off to continue. */
  readonly resume?: { readonly transcript: ReadonlyArray<unknown>; readonly continuation?: string }
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

export const SEND_NUDGE = "Send your reply with send_message."

/** A tool result's `details` when a stop cut the call off: resume runs the call again. */
const INTERRUPTED = { interrupted: true } as const

/** The contract's tool (DESIGN §7.2): the message, ending the turn; one a turn. */
const sendMessageTool = (onSend: (message: string) => boolean): AgentTool => ({
  ...sendMessageDefinition,
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
const liveSuffix = (messages: ReadonlyArray<AgentMessage | Message>): Array<Message> => {
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
      const send = (message: string) => {
        if (sent !== undefined) return false
        sent = message
        emit(message)
        return true
      }
      const sendTool = sendMessageTool(send)
      // A resume offers the definitions its snapshot froze, exactly as they were sent.
      const frozen = (run.offered ?? tools.map(frozenTool)).filter((t) => t.name !== SEND_MESSAGE)
      const piTools: ReadonlyArray<Tool> = [
        ...frozen.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Tool["parameters"]
        })),
        ...(sends ? [{ name: sendTool.name, description: sendTool.description, parameters: sendTool.parameters }] : [])
      ]
      const emit = (chunk: GenerationChunk) => void Queue.offerUnsafe(queue, chunk)

      /** The typed failure behind an `error` turn, for the version's failure class. */
      let failure: GenerationFailed | undefined
      const seed = run.resume?.transcript as ReadonlyArray<AgentMessage> | undefined
      // A resumed run counts the requests it made before, so its turn cap still holds.
      let requests = seed?.filter((m) => m.role === "assistant").length ?? 0
      /** Text a stop cut off: the first request sends it as the reply's start, and its output goes on from it. */
      let continuation = run.resume?.continuation
      /** What this turn streamed into the body: any output, and text in particular. */
      const body = { text: false, prose: false }
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
        const last = requests >= plan.turnCap || carried !== undefined
        const suffix = liveSuffix(transcript.messages)
        const wire = rolloutRequest(
          prefix,
          model.api,
          carried === undefined
            ? suffix
            : [...suffix, { ...emptyAssistant(piModel), content: [{ type: "text", text: carried }] }],
          last ? undefined : piTools,
          { explicitTail: model.cacheBreakpoints === "explicit" }
        )
        // Text streams into the body as it comes; a tool call in the same turn makes it an
        // intermediate step, and the body starts over (DESIGN §7.2: not the message).
        body.text = false
        body.prose = false
        let called = false
        let done: AssistantMessage | undefined
        let partial: AssistantMessage = {
          ...emptyAssistant(piModel),
          content: carried === undefined ? [] : [{ type: "text", text: carried }]
        }
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
                breakpoints: wire.breakpoints,
                ...(wire.stable ? { stable: wire.stable } : {})
              },
              attribution: {
                purpose: input.purpose ?? "generation",
                chatId: request.chatId,
                rolloutId,
                versionId: request.versionId
              }
            })
            .pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "waiting-cache") request.onWaitingCache?.(event.waiting)
                  else if (event.type === "done") done = event.message
                  else if (event.type === "toolcall") {
                    const sending = sends && event.name === SEND_MESSAGE && !last
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
          if (Exit.isSuccess(exit) && done && carried !== undefined) {
            // The reply goes on from the text cut off: one turn, as if it had never stopped.
            const at = done.content.findIndex((p) => p.type === "text")
            const content = done.content.slice()
            if (at < 0) content.unshift({ type: "text", text: carried })
            else content[at] = { type: "text", text: carried + (content[at] as { text: string }).text }
            done = { ...done, content }
          }
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
            ...partial,
            stopReason: aborted ? "aborted" : "error",
            errorMessage: aborted ? "Stopped." : failure!.message
          }
          events.push({ type: "error", reason: aborted ? "aborted" : "error", error: message })
          events.end(message)
        })
        return events
      }

      const cache = new Map<string, unknown>()
      const context = (toolCallId: string) => ({
        cache,
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
        execute: async (toolCallId, params, signal) => {
          // A committed call's receipt takes precedence over validation against its own
          // changed state (a note may now exist, or its old passage may already be gone).
          const execute =
            tool.effect === "chat_state"
              ? run.reader
                  .RolloutReceipt({ userId: request.userId, rolloutId, toolCallId })
                  .pipe(
                    Effect.flatMap((receipt) =>
                      receipt === null
                        ? tool.execute(context(toolCallId), params as never)
                        : Effect.succeed<ToolOutput>({ text: receipt })
                    )
                  )
              : tool.execute(context(toolCallId), params as never)
          // A stop interrupts the tool; its result says so, and a resume runs the call again.
          const exit = await runPromise(Effect.exit(execute), {
            signal
          }).catch(() => undefined)
          if (signal?.aborted || exit === undefined || Exit.isFailure(exit))
            return {
              content: [{ type: "text", text: signal?.aborted ? "Stopped." : "The tool failed." }],
              details: signal?.aborted ? INTERRUPTED : null,
              isError: true
            }
          const result = exit.value
          if (tool.effect === "chat_state" && !result.isError) run.onState?.()
          return {
            content: [{ type: "text", text: budgetResult(result.text) }],
            details: null,
            ...(result.isError ? { isError: true } : {})
          }
        }
      }))

      if (sends) agentTools.push(sendTool)
      let nudged = seed?.some((m) => m.role === "rpHarness" && m.content === SEND_NUDGE) ?? false
      let nudgeSent = nudged
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
            ? seed.slice()
            : [
                { role: "rpRequest", timestamp: Date.now() },
                ...(plan.turnCap <= 1
                  ? [{ role: "rpHarness" as const, content: WRITE_NOW, timestamp: Date.now() }]
                  : [])
              ]
        },
        convertToLlm: (messages) => liveSuffix(messages),
        streamFn,
        toolExecution: "sequential",
        beforeToolCall: async ({ toolCall }) => {
          const tool = tools.find((entry) => entry.id === toolCall.name)
          if (tool?.effect === "external" && run.allowsOutside !== true)
            return { block: true, reason: "This chat does not allow tools with outside effects." }
          if (requests >= plan.turnCap) return { block: true, reason: "The final turn cannot use tools." }
          if (sent !== undefined) return { block: true, reason: "The reply has already been sent." }
          // A process kill after an effect commits must leave its call ID durable,
          // so recovery can replay the receipt instead of sampling a duplicate call.
          const saved = await flush()
          return saved ? undefined : { block: true, reason: "The tool call could not be saved. Go on without it." }
        },
        // One message a turn (DESIGN §7.2): a sent message ends the loop. Under `send_message`
        // alone, a reply written as plain text is asked once to be sent; then it's taken as it is.
        finishTurn: ({ message }, signal) => {
          // The cap's request is the last, whatever it asked for; a stop ends the loop here.
          if (sent !== undefined || requests >= plan.turnCap || signal?.aborted) return { action: "end" }
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
          requests === plan.turnCap - 1
            ? { messages: [{ role: "rpHarness", content: WRITE_NOW, timestamp: Date.now() }] }
            : nudged && !nudgeSent
              ? ((nudgeSent = true), { messages: [{ role: "rpHarness", content: SEND_NUDGE, timestamp: Date.now() }] })
              : undefined
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
      // A resumed run first runs the calls it had made without results (receipts make a
      // chat-state call already written answer as it did), then goes on as the loop would.
      // A terminal send may have been flushed before the process died, while the version's
      // completion was not. Restore it through the ordinary output pipeline without a new turn.
      if (sends && seed) {
        const delivered = new Set(
          seed.flatMap((m) =>
            m.role === "toolResult" && m.toolName === SEND_MESSAGE && !m.isError ? [m.toolCallId] : []
          )
        )
        for (const message of seed) {
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
      }
      const dangling = sent === undefined ? danglingCalls(agent.state.messages) : []
      if (dangling.length > 0) {
        const signal = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => signal.abort()))
        for (const call of dangling) {
          const tool = agentTools.find((t) => t.name === call.name)
          const result = tool
            ? yield* Effect.promise(() =>
                tool.execute(call.id, call.arguments as never, signal.signal).catch((error: unknown) => ({
                  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
                  details: null,
                  isError: true
                }))
              )
            : {
                content: [{ type: "text" as const, text: `There's no tool “${call.name}”.` }],
                details: null,
                isError: true
              }
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
      // The call carried on was the message itself.
      if (sent !== undefined) {
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
