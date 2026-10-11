// Running generations (DESIGN §3.1): one fiber each, any number at once, several under one
// slot. Their text streams to the chat's subscribers as deltas and is saved now and then,
// so a crash keeps most of it. Stopping one keeps its text; a failure becomes a failed
// version with its cause. Everything here runs on the main thread and never blocks it:
// text arrives in chunks, and storage is a message to the writer worker.
import type { ChatId, Version, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { Writer } from "../db/Database.ts"
import { ChatHub } from "./ChatHub.ts"
import { type GenerationFailed, type GenerationRequest, Generator, type GeneratorShape } from "./Generator.ts"

/** How often a generating version's text so far is saved. */
const SAVE_EVERY_MS = 2000

interface Running {
  readonly request: GenerationRequest
  text: string
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
    readonly live: (chatId: ChatId) => Array<{ readonly versionId: VersionId; readonly text: string }>
    /** The versions generating in a chat. */
    readonly runningIn: (chatId: ChatId) => Array<VersionId>
  }
>()("rp/chat/Generations") {
  static readonly layer = Layer.effect(
    Generations,
    Effect.gen(function* () {
      const writer = yield* Writer
      const hub = yield* ChatHub
      const generator = yield* Generator
      const scope = yield* Effect.scope
      const running = new Map<VersionId, Running>()

      // Versions a previous process left generating can't continue: they keep their text.
      const { interrupted } = yield* writer.InterruptGenerations()
      if (interrupted > 0) yield* Effect.logWarning(`${interrupted} generations were interrupted by the last shutdown`)

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
          const saved = yield* Effect.exit(save(entry, status, error))
          running.delete(request.versionId)
          if (Exit.isFailure(saved))
            return yield* Effect.logError(`saving generation ${request.versionId} failed`, saved.cause)
          entry.final = saved.value
          hub.publish(request.chatId, { _tag: "Version", version: saved.value })
        })

      const run = (gen: GeneratorShape, entry: Running) =>
        gen.generate(entry.request).pipe(
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
                Effect.tapCause((cause) => Effect.logWarning("saving a generation's text so far failed", cause)),
                Effect.ignore
              )
            })
          ),
          Effect.onExit((exit) => finish(entry, exit))
        )

      return Generations.of({
        start: (request) =>
          Effect.gen(function* () {
            if (Option.isNone(generator)) return yield* Effect.die(new Error("no generator: refuse before writing"))
            const entry: Running = {
              request,
              text: "",
              savedAt: Date.now(),
              stopped: false,
              fiber: undefined,
              final: undefined
            }
            running.set(request.versionId, entry)
            entry.fiber = yield* Effect.forkIn(run(generator.value, entry), scope)
          }),
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
            .map((entry) => ({ versionId: entry.request.versionId, text: entry.text })),
        runningIn: (chatId) =>
          [...running.values()]
            .filter((entry) => entry.request.chatId === chatId)
            .map((entry) => entry.request.versionId)
      })
    })
  )
}
