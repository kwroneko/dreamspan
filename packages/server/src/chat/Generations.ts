import { Summarizer } from "../lcm/Summarizer.ts"
// Running generations (DESIGN §3.1): one fiber each, any number at once, several under one
// slot. Their text streams to the chat's subscribers as deltas and is saved now and then,
// so a crash keeps most of it. Stopping one keeps its text; a failure becomes a failed
// version with its cause. Everything here runs on the main thread and never blocks it:
// text arrives in chunks, and storage is a message to the writer worker.
import type { ChatId, SlotId, Version, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import type { QueueOutcome } from "../db/ops.ts"
import { ChatHub } from "./ChatHub.ts"
import { Notices } from "./Notices.ts"
import { type GenerationFailed, type GenerationRequest, Generator, type GeneratorShape } from "./Generator.ts"

/** How often a generating version's text so far is saved. */
const SAVE_EVERY_MS = 2000

interface Running {
  readonly request: GenerationRequest
  text: string
  waitingCache: boolean
  savedAt: number
  /** Stopped by the user (`stopped`), as opposed to the server going down (`interrupted`). */
  stopped: boolean
  fiber: Fiber.Fiber<void, GenerationFailed> | undefined
  /** The version as saved when the generation ended. */
  final: Version | undefined
}

export class Generations extends Context.Service<
  Generations,
  {
    /** Starts generating into a version that was just created with status `generating`. */
    readonly start: (request: GenerationRequest) => Effect.Effect<void>
    /** Stops one generation and returns its version as saved; NotFound unless it's running and the user's. */
    readonly stop: (userId: UserId, versionId: VersionId) => Effect.Effect<Version, NotFound>
    /** The text so far of each version generating in a chat. */
    readonly live: (
      chatId: ChatId
    ) => Array<{ readonly versionId: VersionId; readonly text: string; readonly waitingCache?: boolean }>
    /** The versions generating in a chat. */
    readonly runningIn: (chatId: ChatId) => Array<VersionId>
    /** After a write moved the send queue: starts the reply it posted, and publishes what changed. */
    readonly continueQueue: (userId: UserId, outcome: typeof QueueOutcome.Type) => Effect.Effect<void>
  }
>()("rp/chat/Generations") {
  static readonly layer = Layer.effect(
    Generations,
    Effect.gen(function* () {
      const summaries = yield* Summarizer
      const writer = yield* Writer
      const reader = yield* Reader
      const hub = yield* ChatHub
      const notices = yield* Notices
      const generator = yield* Generator
      const scope = yield* Effect.scope
      const running = new Map<VersionId, Running>()

      // Versions a previous process left generating can't continue: they keep their text.
      // What was queued behind them posts without replies (chatSetupWrites.ts).
      const { interrupted, queued } = yield* writer.InterruptGenerations()
      if (interrupted > 0) yield* Effect.logWarning(`${interrupted} generations were interrupted by the last shutdown`)
      if (queued > 0)
        yield* Effect.logWarning(`${queued} queued messages were posted or dropped after the last shutdown`)

      const save = (entry: Running, status: Version["status"], error: Version["error"]) =>
        writer.SaveGeneration({
          userId: entry.request.userId,
          versionId: entry.request.versionId,
          content: entry.text,
          status,
          error
        })

      const finish = (entry: Running, exit: Exit.Exit<void, GenerationFailed>) =>
        Effect.gen(function* () {
          const { request } = entry
          let status: Version["status"] = "complete"
          let error: Version["error"] = null
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterruptsOnly(exit.cause)) {
              status = entry.stopped ? "stopped" : "interrupted"
            } else {
              status = "failed"
              const failure = Cause.findErrorOption(exit.cause)
              if (Option.isSome(failure)) {
                error = { class: failure.value.class, message: failure.value.message }
              } else {
                yield* Effect.logError("generation crashed", exit.cause)
                error = { class: "unknown", message: "The generation failed unexpectedly." }
              }
            }
          }
          // The final save posts what was queued behind this reply, in the same transaction.
          const saved = yield* Effect.exit(
            writer.FinishGeneration({
              userId: request.userId,
              versionId: request.versionId,
              content: entry.text,
              status,
              error
            })
          )
          running.delete(request.versionId)
          if (Exit.isFailure(saved))
            return yield* Effect.logError(`saving generation ${request.versionId} failed`, saved.cause)
          const finished = saved.value
          entry.final = finished.version
          hub.publish(request.chatId, { _tag: "Version", version: finished.version })
          // A reply that ended on its own is news wherever the user is (DESIGN §10.1).
          if (status === "complete" || status === "failed") {
            notices.publish(request.userId, {
              _tag: "ReplyFinished",
              chatId: request.chatId,
              slotId: request.slotId,
              versionId: request.versionId,
              status
            })
          }
          if (status === "complete")
            yield* summaries.afterReply({ userId: request.userId, chatId: request.chatId, leafSlotId: request.slotId })
          yield* continueQueue(request.userId, finished)
        })

      /**
       * After the queue moved: the reply it posted starts, and subscribers hear of both. The
       * queue goes out first, before anything here waits, so queue events leave in the order
       * the writer committed them: a reply posted from this queue may end at once and publish
       * the next queue, and an older one must never follow it.
       */
      const continueQueue = (userId: GenerationRequest["userId"], outcome: typeof QueueOutcome.Type) =>
        Effect.gen(function* () {
          if (!outcome.queueChanged) return
          hub.publish(outcome.chatId, { _tag: "Queue", queue: outcome.queue })
          if (outcome.next !== null) {
            yield* startGeneration({
              userId,
              chatId: outcome.chatId,
              slotId: outcome.next.slotId,
              versionId: outcome.next.versionId
            })
          }
          yield* publishPosted(userId, outcome.chatId, outcome.posted)
        })

      /** Slots the queue posted, then the chat whose leaf they moved. */
      const publishPosted = (userId: GenerationRequest["userId"], chatId: ChatId, posted: ReadonlyArray<SlotId>) =>
        Effect.gen(function* () {
          if (posted.length === 0) return
          for (const slotId of posted) {
            const { entry } = yield* reader.GetSlot({ userId, slotId })
            hub.publish(chatId, { _tag: "Slot", entry })
          }
          hub.publish(chatId, { _tag: "Chat", chat: yield* reader.GetChat({ userId, chatId }) })
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("publishing posted messages failed", cause)))

      const run = (gen: GeneratorShape, entry: Running) =>
        gen
          .generate({
            ...entry.request,
            onWaitingCache: (waiting) => {
              entry.waitingCache = waiting
              hub.publish(entry.request.chatId, { _tag: "WaitingCache", versionId: entry.request.versionId, waiting })
            }
          })
          .pipe(
            Stream.runForEach((chunk) =>
              Effect.suspend(() => {
                const offset = entry.text.length
                entry.text += chunk
                hub.publish(entry.request.chatId, {
                  _tag: "Delta",
                  versionId: entry.request.versionId,
                  offset,
                  text: chunk
                })
                if (Date.now() - entry.savedAt < SAVE_EVERY_MS) return Effect.void
                entry.savedAt = Date.now()
                return save(entry, "generating", null).pipe(
                  // Gone for good (purged from the bin): nothing it writes would be kept.
                  Effect.catchTag("NotFound", () =>
                    Effect.suspend(() => {
                      entry.stopped = true
                      return Effect.interrupt
                    })
                  ),
                  Effect.tapCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.void
                      : Effect.logWarning("saving a generation's text so far failed", cause)
                  ),
                  Effect.catchTag(["StorageError", "RpcClientError"], () => Effect.void)
                )
              })
            ),
            Effect.onExit((exit) => finish(entry, exit))
          )

      const startGeneration = (request: GenerationRequest): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (Option.isNone(generator)) return yield* Effect.die(new Error("no generator: refuse before writing"))
          const entry: Running = {
            request,
            text: "",
            waitingCache: false,
            savedAt: Date.now(),
            stopped: false,
            fiber: undefined,
            final: undefined
          }
          running.set(request.versionId, entry)
          entry.fiber = yield* Effect.forkIn(run(generator.value, entry), scope)
        })

      return Generations.of({
        start: startGeneration,
        continueQueue,
        stop: (userId, versionId) =>
          Effect.gen(function* () {
            const entry = running.get(versionId)
            if (entry === undefined || entry.request.userId !== userId || entry.fiber === undefined) {
              return yield* new NotFound({ entity: "generation", id: versionId })
            }
            entry.stopped = true
            yield* Fiber.interrupt(entry.fiber)
            if (entry.final === undefined) return yield* new NotFound({ entity: "generation", id: versionId })
            return entry.final
          }),
        live: (chatId) =>
          [...running.values()]
            .filter((entry) => entry.request.chatId === chatId)
            .map((entry) => ({
              versionId: entry.request.versionId,
              text: entry.text,
              waitingCache: entry.waitingCache
            })),
        runningIn: (chatId) =>
          [...running.values()]
            .filter((entry) => entry.request.chatId === chatId)
            .map((entry) => entry.request.versionId)
      })
    })
  )
}
