import { AppConfig } from "../config.ts"
import { hydrateMessageImages } from "../chat/messageImages.ts"
import { executionRegistry } from "../execution.ts"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import type { ChatId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
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
import { clipSummary } from "./summaryTool.ts"
import { DIRECT_INSTRUCTION } from "./instructions.ts"

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

type PlanReason = "reply" | "completion"

type Position = {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly leafSlotId: SlotId
  /** The fork whose choices it plans with (a reply's own); absent: the fork through the leaf. */
  readonly forkId?: ForkId
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
    readonly planNow: (position: Position, reason?: PlanReason) => Effect.Effect<ReadonlyArray<SummaryJob>>
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
    const config = yield* AppConfig
    const execution = yield* executionRegistry
    const reader = yield* Reader,
      writer = yield* Writer,
      providers = yield* Providers,
      checks = yield* SummaryChecks,
      hub = yield* ChatHub
    const scope = yield* Effect.scope
    const running = new Map<string, SummaryJob>()
    const users = new Set<UserId>(),
      due = new Map<string, { position: Position; at: number; reason: PlanReason | undefined }>()
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
          // Pin execution and instruction policy together before the worker read yields.
          // Scope changes affect the next attempt, never half of an in-flight attempt.
          const strategies = new Map(execution.summaries.list().map((entry) => [entry.id, entry]))
          const factories = new Map(execution.summaryTools.list().map((entry) => [entry.id, entry]))
          const tools = { get: (id: string) => factories.get(id), list: () => [...factories.values()] }
          const instructionEntries = yield* Effect.forEach([...strategies], ([id, strategy]) =>
            Effect.try(() => {
              const instruction = strategy.instruction?.(tools) ?? DIRECT_INSTRUCTION
              return [[id, instruction && !instruction.startsWith("\n") ? `\n${instruction}` : instruction] as const]
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`Summary strategy ${id} instruction is unavailable`, error).pipe(Effect.as([]))
              )
            )
          )
          // A broken unselected strategy must not block the selected one. Missing
          // instructions fail clearly only if the worker selects that strategy.
          const instructions = Object.fromEntries(instructionEntries.flat())
          const assemble = reader.AssembleSummary({
            userId: job.userId,
            jobId: job.id,
            attempt: job.epoch,
            instructions
          })
          let assembled = yield* assemble
          // A summary request is a generation too (owner, 2026-11-01): library text it uses that
          // changed since its last revision gets a revision labelled with it, and it's
          // assembled again from that, as a reply is (ContextGenerator).
          for (let round = 0; round < 3; round++) {
            const { cut } = yield* writer.CheckpointLiveText({
              userId: job.userId,
              chatId: job.chatId,
              forkId: job.forkId,
              slotId: job.lastSlotId,
              versionId: null,
              summary: { from: assembled.from, to: assembled.to },
              leafSlotId: job.lastSlotId,
              message: assembled.to,
              used: assembled.used
            })
            if (cut === 0) break
            hub.publish(job.chatId, { _tag: "State" })
            assembled = yield* assemble
          }
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
          const strategy = strategies.get(snapshot.summaryJob!.style)
          if (!strategy)
            return yield* Effect.fail(new Error(`Summary strategy ${snapshot.summaryJob!.style} is unavailable.`))
          const output = yield* Effect.try(() => strategy.create({ job, snapshot }, tools))
          const hydrated = yield* hydrateMessageImages(
            generation.request,
            model,
            (mediaId) => reader.GetMediaFile({ userId: job.userId, mediaId }),
            config.dataDir
          )
          const wire = providerRequest(hydrated, model)
          candidate = output.candidate
          let context = output.tools ? { ...wire.context, tools: output.tools } : wire.context
          const extras: Message[] = []
          for (let turn = 0; turn < 8; turn++) {
            output.beginTurn()
            let answer: AssistantMessage | undefined
            let payload = wire.payload
            if (extras.length && model.api === "openai-completions") {
              payload = {
                ...payload,
                messages: [
                  ...((wire.payload?.messages as Array<unknown>) ?? []),
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
                    if (event.type === "text") output.onText(event.delta)
                  })
                )
              )
            if (!answer) return yield* Effect.fail(new Error("The provider returned no result."))
            const reply: AssistantMessage = answer
            const { done, content, appended } = output.accept(reply)
            extras.push(...appended)
            if (appended.length) context = { ...context, messages: [...context.messages, ...appended] }
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
              children: snapshot.summaryJob!.children ?? []
            })
            return
          }
        })
        yield* work.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!(error instanceof ProviderError)) return yield* Effect.fail(error)
              if (error.reason === "budget_held") return yield* error
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
                  .pipe(
                    Effect.catch((failure) =>
                      failure instanceof ProviderError && failure.reason === "budget_held"
                        ? Effect.fail(failure)
                        : Effect.succeed("refused" as const)
                    )
                  )
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
                children: frozenInputs.children ?? []
              })
            })
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (Exit.isFailure(exit)) {
                const failure = Cause.findErrorOption(exit.cause)
                const held =
                  failure._tag === "Some" &&
                  failure.value instanceof ProviderError &&
                  failure.value.reason === "budget_held"
                if (Cause.hasInterruptsOnly(exit.cause) || held)
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
              if (pool && !(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)))
                schedule(
                  {
                    userId: job.userId,
                    chatId: job.chatId,
                    leafSlotId: job.leafSlotId,
                    ...(job.forkId ? { forkId: job.forkId } : {})
                  },
                  "completion"
                )
            })
          )
        )
      })
    /** Plans what a reply (or, continuing its work, a finished job) should start, and enqueues it. */
    const plan = (position: Position, interactive = false, reason?: PlanReason) =>
      Effect.gen(function* () {
        users.add(position.userId)
        const p = yield* reader.PlanSummaries({ ...position, ...(reason ? { reason } : {}) })
        if (p.enabled && p.maintenancePins && reason === "reply")
          yield* writer.SaveLcmMaintenance({ ...position, pins: p.maintenancePins })
        // The chat's backfill (spec/LCM.md §2.11): a reply begins it, and it is over when nothing is left.
        const backfill = (action: "begin" | "finish") =>
          writer
            .SetBackfill({ userId: position.userId, chatId: position.chatId, forkId: position.forkId ?? null, action })
            .pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(changed(position.chatId))
            )
        if (p.backfill?.armed && reason === "reply") yield* backfill("begin")
        if (p.backfill?.settled) yield* backfill("finish")
        const held = p.backfill?.held === true
        if (p.enabled && !interactive && !held) {
          const explicitChunks = p.refresh.filter((c) => c.explicitRequested || c.rerunIds?.length)
          const explicitCondensations = p.condensations.filter((c) => c.explicitRequested || c.rerunIds?.length)
          const chunks = p.spendAhead || p.backfill?.drive === true ? [...p.chunks, ...p.refresh] : explicitChunks
          const jobs = p.spendAhead || p.backfill?.drive === true ? p.condensations : explicitCondensations
          const made = chunks.length
            ? yield* writer.EnqueueSummaries({ ...position, chunks, requestClass: "idle" })
            : []
          const condensed = jobs.length
            ? yield* writer.EnqueueCondensations({ ...position, jobs, requestClass: "idle" })
            : []
          if (made.length || condensed.length) yield* changed(position.chatId)
          if (pool && [...made, ...condensed].some((j) => j.status === "complete")) schedule(position, "completion")
          return { ...p, jobs: [...p.jobs, ...made, ...condensed] }
        }
        if (p.enabled && p.chunks.length && interactive && p.over && !held) {
          const jobs = yield* writer.EnqueueSummaries({ ...position, chunks: p.chunks, requestClass: "interactive" })
          if (jobs.length) yield* changed(position.chatId)
          return { ...p, jobs: [...p.jobs, ...jobs] }
        }
        return p
      })
    /** Plans for a chat after a delay that lets triggers coalesce; a reply's pass is not weakened by a job's. */
    const schedule = (position: Position, reason: PlanReason | undefined) => {
      const key = `${position.chatId}:${position.forkId ?? ""}`
      const prior = due.get(key)
      const kept = prior?.reason === "reply"
      due.set(key, {
        position: kept && reason !== "reply" ? prior.position : position,
        at: Date.now() + 250,
        reason: kept ? "reply" : reason
      })
    }
    const startup = yield* writer.ResetSummaryJobs()
    for (const p of startup) {
      users.add(p.userId)
      schedule(
        { userId: p.userId, chatId: p.chatId, leafSlotId: p.leafSlotId, ...(p.forkId ? { forkId: p.forkId } : {}) },
        "completion"
      )
    }
    if (pool)
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (true) {
            for (const [chatId, p] of due)
              if (p.at <= Date.now()) {
                due.delete(chatId)
                yield* plan(p.position, false, p.reason).pipe(
                  Effect.catchCause((cause) => {
                    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                    // Keep the already-frozen reply authorization; an enqueue race never authorizes later edits.
                    const error = Cause.findErrorOption(cause)
                    if (error._tag === "Some" && error.value._tag === "StorageError") schedule(p.position, "completion")
                    return Effect.logWarning("LCM planning failed", cause)
                  })
                )
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
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.interrupt
                      : Effect.logWarning("LCM reconciliation failed", cause).pipe(Effect.as(false))
                  )
                )
              if (!reconciled) continue
              for (let n = 0; n < 2; n++) {
                const job = yield* writer
                  .ClaimSummaryJob({ userId })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.interrupt
                        : Effect.logWarning("LCM claim failed", cause).pipe(Effect.as(null))
                    )
                  )
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
        // A paused or capped backfill starts nothing: the send goes on with what is left out reported.
        if (p.backfill?.held) return over
        while (p.over && p.jobs.length && !p.backfill?.held && Date.now() < deadline) {
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
      planNow: (position, reason = "reply") =>
        plan(position, false, reason).pipe(
          Effect.map((p) => p.jobs),
          Effect.orDie
        ),
      afterReply: (position) =>
        Effect.sync(() => {
          if (pool) schedule(position, "reply")
        }),
      beforeReply: pool ? waitForRunway : () => Effect.succeed(false)
    })
  })
}
