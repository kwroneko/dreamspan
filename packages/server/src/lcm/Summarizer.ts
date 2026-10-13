import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import type { ChatId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Cause, Context, Effect, Exit, Layer, Stream } from "effect"
import type { ContextSnapshot, Generation } from "../assembler/types.ts"
import { providerRequest } from "../assembler/wire.ts"
import { ChatHub } from "../chat/ChatHub.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { SummaryJob } from "../db/lcmJobs.ts"
import { ProviderError, Providers } from "../providers/Providers.ts"
import { JudgeUnavailable } from "../decision/RefusalJudge.ts"
import { SummaryChecks } from "./OutputChecks.ts"
import { summaryDraft, summaryTool, clipSummary } from "./summaryTool.ts"

/** A check refused the output; it is not saved, and the attempt fails. */
class SummaryRefused {
  readonly _tag = "SummaryRefused"
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

/** How an attempt's failure is recorded on the job and, at the end, on the failed summary. */
const describeFailure = (cause: Cause.Cause<unknown>) => {
  const found = Cause.findErrorOption(cause)
  const error = found._tag === "Some" ? found.value : undefined
  if (error instanceof ProviderError)
    return {
      error: error.message,
      errorClass: error.reason,
      ...(error.reason === "refused" ? { errorKind: "hard" as const, errorCategory: error.category } : {})
    }
  if (error instanceof SummaryRefused)
    return { error: error.message, errorClass: "refused", errorKind: "soft" as const }
  if (error instanceof JudgeUnavailable) return { error: error.message, errorClass: "judge" }
  return { error: Cause.pretty(cause).slice(0, 2000), errorClass: "unknown" }
}

type Position = {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly leafSlotId: SlotId
  readonly triggerVersionId?: VersionId
}
export class Summarizer extends Context.Service<
  Summarizer,
  {
    readonly afterReply: (position: Position) => Effect.Effect<void>
    readonly beforeReply: (position: Position) => Effect.Effect<boolean>
    /** Runs a job this caller claimed to its outcome: completed, retried, failed or released. */
    readonly runJob: (job: SummaryJob) => Effect.Effect<void>
    /** Plans and enqueues now, as after a reply; the jobs it made. */
    readonly planNow: (position: Position) => Effect.Effect<ReadonlyArray<SummaryJob>>
  }
>()("rp/lcm/Summarizer") {
  static readonly none = Layer.succeed(Summarizer)({
    afterReply: () => Effect.void,
    beforeReply: () => Effect.succeed(false),
    runJob: () => Effect.void,
    planNow: () => Effect.succeed([])
  })
  static readonly layer = Layer.effect(Summarizer, makeSummarizer(true))
  /** The same service without its background pool: whoever holds it claims and runs jobs itself (tests). */
  static readonly manual = Layer.effect(Summarizer, makeSummarizer(false))
}

/** The summarizer; with `pool` false it has no background claiming, and the caller runs jobs itself (tests). */
export function makeSummarizer(pool: boolean) {
  return Effect.gen(function* () {
    const reader = yield* Reader,
      writer = yield* Writer,
      providers = yield* Providers,
      checks = yield* SummaryChecks,
      hub = yield* ChatHub
    const scope = yield* Effect.scope
    const running = new Map<string, SummaryJob>()
    const users = new Set<UserId>(),
      due = new Map<string, { position: Position; at: number }>()
    /** Open chats read their summaries again (ChatEvent `Lcm`). */
    const changed = (chatId: ChatId) => Effect.sync(() => hub.publish(chatId, { _tag: "Lcm" }))
    const safe = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catchCause((c) =>
          Cause.hasInterruptsOnly(c) ? Effect.interrupt : Effect.logWarning("LCM job failed", c)
        )
      )
    const run = (job: SummaryJob) =>
      Effect.gen(function* () {
        let rolloutId: string | null = null
        let frozenInputs: ContextSnapshot["summaryJob"]
        let candidate = () => ""
        let rejected = false
        const work = Effect.gen(function* () {
          const assembled = yield* reader.AssembleSummary({ userId: job.userId, jobId: job.id, attempt: job.epoch })
          const snapshot = JSON.parse(assembled.snapshot) as ContextSnapshot,
            generation = JSON.parse(assembled.generation) as Generation
          frozenInputs = snapshot.summaryJob
          const model = generation.model
          if (!model) return yield* Effect.fail(new Error("No summarizer model selected."))
          const id = uuidv7()
          yield* writer.StartSummaryRollout({
            userId: job.userId,
            jobId: job.id,
            attempt: job.epoch,
            rolloutId: id,
            snapshot: assembled.snapshot
          })
          rolloutId = id
          const wire = providerRequest(generation.request, model),
            draft = summaryDraft(Math.ceil(job.target * 2.5))
          let responseText = ""
          candidate = () => (snapshot.summaryJob!.style === "tool" ? (draft.content() ?? "") : responseText)
          let context = wire.context
          if (snapshot.summaryJob!.style === "tool") context = { ...context, tools: [summaryTool] }
          const extras: Message[] = []
          for (let turn = 0; turn < 8; turn++) {
            responseText = ""
            let answer: AssistantMessage | undefined
            let payload = wire.payload
            if (extras.length && model.api === "openai-completions") {
              payload = {
                ...payload,
                messages: [
                  ...generation.request.messages,
                  ...extras.map((m) =>
                    m.role === "assistant"
                      ? {
                          role: "assistant",
                          content: m.content
                            .filter((p) => p.type === "text")
                            .map((p) => p.text)
                            .join(""),
                          tool_calls: m.content
                            .filter((p) => p.type === "toolCall")
                            .map((p) => ({
                              id: p.id,
                              type: "function",
                              function: { name: p.name, arguments: JSON.stringify(p.arguments) }
                            }))
                        }
                      : m.role === "toolResult"
                        ? {
                            role: "tool",
                            tool_call_id: m.toolCallId,
                            content: m.content
                              .filter((p) => p.type === "text")
                              .map((p) => p.text)
                              .join("")
                          }
                        : m
                  )
                ]
              }
            }
            yield* providers
              .stream({
                userId: job.userId,
                connectionId: model.connectionId as ConnectionId,
                modelId: model.modelId as ModelId,
                context,
                inspection: { request: generation.request, model, display: generation.inspection },
                options: { ...wire, payload, sessionId: job.chatId },
                attribution: {
                  purpose: job.level === 1 ? "summarize" : "condense",
                  chatId: job.chatId,
                  rolloutId: id
                }
              })
              .pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    if (event.type === "done") answer = event.message
                    if (event.type === "text") responseText += event.delta
                  })
                )
              )
            if (!answer) return yield* Effect.fail(new Error("The provider returned no result."))
            const reply: AssistantMessage = answer
            const calls = reply.content.filter((p) => p.type === "toolCall")
            let done = snapshot.summaryJob!.style === "direct",
              content = reply.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
            if (!done) {
              const appended: Message[] = [reply]
              for (const call of calls) {
                const result =
                  call.name === "summary_tool"
                    ? draft.execute(call.arguments)
                    : { text: "Error: Only summary_tool is available.", done: false, isError: true }
                appended.push({
                  role: "toolResult",
                  toolCallId: call.id,
                  toolName: call.name,
                  content: [{ type: "text", text: result.text }],
                  isError: result.isError,
                  timestamp: Date.now()
                })
                done ||= result.done
              }
              extras.push(...appended)
              context = { ...context, messages: [...context.messages, ...appended] }
              content = draft.content() ?? ""
              done ||= !calls.length
            }
            if (!done && turn < 7) continue
            if (!content.trim()) return yield* Effect.fail(new Error("The summary is empty."))
            for (const check of checks.list()) {
              rejected = true
              const verdict = yield* check.check({
                userId: job.userId,
                chatId: job.chatId,
                text: content,
                rolloutId: id,
                instruction: snapshot.summaryJob!.tail
              })
              if (verdict === "refused")
                return yield* Effect.fail(new SummaryRefused("The decision model judged the output a refusal."))
              rejected = false
            }
            const truncated = reply.stopReason === "length" || turn === 7 || content.length > job.target * 10
            yield* writer.CompleteSummary({
              userId: job.userId,
              jobId: job.id,
              rolloutId: id,
              content: truncated ? clipSummary(content, job.target) : content,
              status: truncated ? "truncated" : "complete",
              inputs: snapshot.summaryJob!.inputs,
              children: []
            })
            return
          }
        })
        yield* work.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!(error instanceof ProviderError)) return yield* Effect.fail(error)
              rejected = error.reason === "refused"
              if (
                job.attempts <= job.maxRetries ||
                rejected ||
                error.reason === "aborted" ||
                !rolloutId ||
                !frozenInputs ||
                !candidate().trim()
              )
                return yield* error
              const content = clipSummary(candidate(), job.target)
              const instruction = frozenInputs.tail
              for (const check of checks.list()) {
                rejected = true
                const verdict = yield* check
                  .check({ userId: job.userId, chatId: job.chatId, text: content, rolloutId, instruction })
                  .pipe(Effect.catch(() => Effect.succeed("refused" as const)))
                if (verdict === "refused") return yield* error
                rejected = false
              }
              yield* writer.CompleteSummary({
                userId: job.userId,
                jobId: job.id,
                rolloutId,
                content,
                status: "truncated",
                inputs: frozenInputs.inputs,
                children: []
              })
            })
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (Exit.isFailure(exit)) {
                if (Cause.hasInterruptsOnly(exit.cause))
                  yield* safe(writer.ReleaseSummaryJob({ userId: job.userId, jobId: job.id, attempt: job.epoch }))
                else
                  yield* safe(
                    writer.FailSummaryAttempt({
                      userId: job.userId,
                      jobId: job.id,
                      attempt: job.epoch,
                      rolloutId,
                      draft: rejected ? null : candidate().slice(0, job.target * 10) || null,
                      ...describeFailure(exit.cause)
                    })
                  )
              }
            })
          )
        )
      })
    const plan = (position: Position, interactive = false) =>
      Effect.gen(function* () {
        users.add(position.userId)
        const p = yield* reader.PlanSummaries(position)
        if (p.enabled && p.chunks.length && ((!interactive && p.spendAhead) || (interactive && p.over))) {
          const jobs = yield* writer.EnqueueSummaries({
            ...position,
            chunks: p.chunks,
            requestClass: interactive && p.over ? "interactive" : "idle"
          })
          if (jobs.length) yield* changed(position.chatId)
          return { ...p, jobs: [...p.jobs, ...jobs] }
        }
        return p
      })
    const startup = yield* writer.ResetSummaryJobs()
    for (const p of startup) {
      users.add(p.userId)
      due.set(p.chatId, { position: p, at: Date.now() + 250 })
    }
    if (pool)
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (true) {
            for (const [chatId, p] of due)
              if (p.at <= Date.now()) {
                due.delete(chatId)
                yield* safe(plan(p.position))
              }
            for (const userId of users) {
              const reconciled = yield* writer
                .ReconcileSummaryJobs({
                  userId,
                  running: [...running.values()]
                    .filter((j) => j.userId === userId)
                    .map((j) => ({ id: j.id, epoch: j.epoch }))
                })
                .pipe(
                  Effect.as(true),
                  Effect.catch((error) => Effect.logWarning("LCM reconciliation failed", error).pipe(Effect.as(false)))
                )
              if (!reconciled) continue
              for (let n = 0; n < 2; n++) {
                const job = yield* writer
                  .ClaimSummaryJob({ userId })
                  .pipe(Effect.catch((error) => Effect.logWarning("LCM claim failed", error).pipe(Effect.as(null))))
                if (!job) break
                running.set(job.id, job)
                yield* changed(job.chatId)
                yield* Effect.forkIn(
                  safe(run(job)).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        running.delete(job.id)
                        hub.publish(job.chatId, { _tag: "Lcm" })
                      })
                    )
                  ),
                  scope
                )
              }
            }
            yield* Effect.sleep(250)
          }
        }).pipe(Effect.catchCause((c) => Effect.logError("LCM pool stopped", c))),
        scope
      )
    const waitForRunway = (position: Position) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 120_000
        let p = yield* plan(position, true)
        const over = p.partialBatch
        while (p.over && p.jobs.length && Date.now() < deadline) {
          for (const job of p.jobs) yield* writer.EscalateSummaryJob({ userId: position.userId, jobId: job.id })
          yield* Effect.sleep(250)
          p = yield* reader.PlanSummaries(position)
        }
        return over
      }).pipe(
        Effect.catchCause((c) =>
          Cause.hasInterruptsOnly(c)
            ? Effect.interrupt
            : Effect.logWarning("LCM planning failed; retaining available originals", c).pipe(Effect.as(false))
        )
      )
    return Summarizer.of({
      runJob: (job) => safe(run(job)),
      planNow: (position) =>
        plan(position).pipe(
          Effect.map((p) => p.jobs),
          Effect.orDie
        ),
      afterReply: (position) =>
        Effect.sync(() => {
          if (pool) due.set(position.chatId, { position, at: Date.now() + 250 })
        }),
      beforeReply: pool ? waitForRunway : () => Effect.succeed(false)
    })
  })
}
