// Decision models (DESIGN §7.6 [D], spec/AGENTIC.md §7) are optional. Each point
// declares its questions, state, resolver and heuristic fallback. Configure one
// connection per point. Nothing is sent unless the user enabled the point for that connection.
// Each call is a rollout of
// kind `decision` with its ledger rows, so the Activity panel lists it with tokens and cost.
// Points are a registry: a plugin adds one, or replaces or removes a built-in, by its id.
import type { ChatId, ForkId, SlotId, Version, VersionId } from "@dreamspan/shared/chat.ts"
import { type DecisionAnswers, type DecisionQuestion, parseAnswers } from "@dreamspan/shared/decisions.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { type ChatState, type FoldableEvent, foldState } from "@dreamspan/shared/state.ts"
import type { ConnectionId, ModelId } from "@dreamspan/shared/providers.ts"
import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { Providers } from "../providers/Providers.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { builtinPoints } from "./points/index.ts"

/** The hard deadline of one decision call (AGENTIC §7: 10 s), unless the point sets its own; past it the fallback decides. */
const DECISION_TIMEOUT_MS = 10_000

/** Where a decision is made: the chat, and the message it decides for. */
interface DecisionContext {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: SlotId | null
  readonly forkId: ForkId | null
  /** A decision a reply waits for is interactive; one after a reply is background. */
  readonly requestClass: "interactive" | "background"
}

/** A reply that just completed, for the points that act after one. */
interface FinishedReply {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: SlotId
  readonly versionId: VersionId
  readonly forkId: ForkId | null
}

/** A reply about to be written, for the points that act before one (its speaker, say). */
interface StartingReply {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: SlotId
  readonly versionId: VersionId
  readonly forkId: ForkId | null
  readonly parentSlotId: SlotId | null
  /** The version as its generation read it when it started. */
  readonly version: Version
  /** The chat's state events at the reply's parent. */
  readonly events: ReadonlyArray<FoldableEvent>
}

interface DecisionServices {
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly evaluate: DecisionEngineShape["evaluate"]
}

/** One decision point. */
export interface DecisionPoint<I, V> {
  readonly id: string
  /** User-facing, for the connection's Decisions settings. */
  readonly label: string
  readonly description: string
  /**
   * User-facing, one sentence: what decides in its place when a chat turns the point off (the
   * chat's Decisions setting and the inspector say it). Absent: nothing is said.
   */
  readonly instead?: string
  /**
   * Whether the point would have been asked about a reply written from this state, for the
   * inspector's note of a point the chat turned off; absent: every reply.
   */
  readonly appliesTo?: (turn: SkippedTurn) => boolean
  /** How sure the model must be, 0.5..1, unless the user sets it. */
  readonly defaultThreshold: number
  /** Its own call deadline, for a point a reply waits on (the engine's otherwise). */
  readonly timeoutMs?: number
  /** The questions for this input; none means there's nothing to ask, and nothing is sent. */
  readonly questions: (input: I) => Readonly<Record<string, DecisionQuestion>>
  /** The state the questions read (a small object of named fields, newest messages kept). */
  readonly state: (input: I) => unknown
  /** The verdict from the answers, or null when the model isn't sure enough. */
  readonly resolve: (answers: DecisionAnswers, input: I, threshold: number) => V | null
  /** Today's behaviour: the verdict without a model. */
  readonly fallback: (input: I) => V
  /** For a point that acts after each completed reply: gathers its input, evaluates, applies; true when it changed something. */
  readonly afterReply?: (reply: FinishedReply, services: DecisionServices) => Effect.Effect<boolean>
  /** For a point that acts before a reply is written: true when it changed the reply's message. */
  readonly beforeReply?: (reply: StartingReply, services: DecisionServices) => Effect.Effect<boolean, unknown>
}

/** A reply being written, as a point says whether it would have been asked about it. */
interface SkippedTurn {
  /** The chat's state at the reply's parent. */
  readonly state: ChatState
  /** Lorebook entries were waiting for the decision model's answer. */
  readonly loreAsked: boolean
}

/** A point a connection has on that the chat turned off (`decision.points`), as the inspector says it. */
interface SkippedPoint {
  readonly id: string
  readonly label: string
  readonly instead: string
}

/** What a point without its own `instead` is said to do when a chat turns it off. */
const INSTEAD_DEFAULT = "The app decided as it does without a decision model."

/** A point with its input and verdict types erased, as the registry holds it. */
export type AnyDecisionPoint = DecisionPoint<never, unknown>

type DecisionSource = "model" | "heuristic"

interface DecisionOutcome<V> {
  readonly value: V
  readonly source: DecisionSource
  /** Why the fallback decided: `off`, `off_in_chat`, `nothing_to_ask`, `timeout`, `error`, `malformed`, `low_confidence`, `unavailable`. */
  readonly reason?: string
  /** The decision's rollout, when a request was sent. */
  readonly rolloutId?: string
}

export interface DecisionEngineShape {
  // A point's input and verdict types are its own; the registry holds them erased.
  readonly points: Registry<AnyDecisionPoint>
  /** Never fails: every failure is the point's fallback, tagged with its reason. */
  readonly evaluate: <I, V>(pointId: string, input: I, context: DecisionContext) => Effect.Effect<DecisionOutcome<V>>
  /** Runs every point that acts after a reply, each on its own; failures are only logged. True when one changed the chat. */
  readonly afterReply: (reply: FinishedReply) => Effect.Effect<boolean>
  /**
   * Runs every point that acts before a reply, in turn, before its context is built; a failure is
   * only logged (the reply goes on as it was), a stop stops it. True when one changed the message.
   */
  readonly beforeReply: (reply: StartingReply) => Effect.Effect<boolean>
  /**
   * The points a connection of the user's has on that the chat's state turns off
   * (`decision.points`) and that would have been asked about this reply. Reads the settings
   * only when the chat turns any off, so a chat that doesn't costs nothing. Never fails.
   */
  readonly skippedIn: (userId: UserId, turn: SkippedTurn) => Effect.Effect<ReadonlyArray<SkippedPoint>>
}

export class DecisionEngine extends Context.Service<DecisionEngine, DecisionEngineShape>()(
  "rp/decision/DecisionEngine"
) {
  /** The engine with the given points (the built-ins by default) and the call deadline. */
  static readonly layerWith = (
    options: { readonly points?: ReadonlyArray<AnyDecisionPoint>; readonly timeoutMs?: number } = {}
  ) =>
    Layer.effect(
      DecisionEngine,
      Effect.gen(function* () {
        const reader = yield* Reader
        const writer = yield* Writer
        const providers = yield* Providers
        const points = makeRegistry<AnyDecisionPoint>()
        for (const point of options.points ?? builtinPoints) yield* points.register(point)

        /** The connection that answers this point: the first, by name, with it on and a model chosen. */
        const answering = (userId: UserId, pointId: string) =>
          Effect.gen(function* () {
            const settings = yield* reader.GetDecisionSettings({ userId })
            const on = settings.filter((entry) => entry.model !== null && entry.points[pointId]?.on === true)
            if (on.length === 0) return null
            if (on.length === 1) return on[0]!
            const names = new Map(
              (yield* reader.ListConnections({ userId })).map((connection) => [
                connection.id as string,
                connection.name
              ])
            )
            return on.toSorted((a, b) =>
              (names.get(a.connectionId) ?? "").localeCompare(names.get(b.connectionId) ?? "")
            )[0]!
          })

        const evaluate: DecisionEngineShape["evaluate"] = <I, V>(
          pointId: string,
          input: I,
          context: DecisionContext
        ): Effect.Effect<DecisionOutcome<V>> => {
          const point = points.get(pointId) as unknown as DecisionPoint<I, V> | undefined
          if (!point) return Effect.die(new Error(`decision point ${pointId} isn't registered`))
          const fallback = (reason: string, rolloutId?: string): DecisionOutcome<V> => ({
            value: point.fallback(input),
            source: "heuristic",
            reason,
            ...(rolloutId ? { rolloutId } : {})
          })
          const timeoutMs = options.timeoutMs ?? point.timeoutMs ?? DECISION_TIMEOUT_MS
          return Effect.gen(function* () {
            const entry = yield* answering(context.userId, pointId)
            // Off for every connection: nothing is built, nothing is sent.
            if (!entry) return fallback("off")
            // Off in this chat at the message decided for (`decision.points`): the same. Read
            // only once a connection has the point on, so nothing changes for anyone else.
            const off = foldState(
              yield* reader.StateEventsAt({
                userId: context.userId,
                chatId: context.chatId,
                slotId: context.slotId,
                forkId: context.forkId
              })
            ).decisionsOff
            if (off?.includes(pointId)) return fallback("off_in_chat")
            const questions = point.questions(input)
            if (Object.keys(questions).length === 0) return fallback("nothing_to_ask")
            const threshold = entry.points[pointId]?.threshold ?? point.defaultThreshold
            const state = point.state(input)
            const rolloutId = uuidv7()
            const connectionId = entry.connectionId as ConnectionId
            const modelId = entry.model as ModelId
            yield* writer.StartDecisionRollout({
              userId: context.userId,
              chatId: context.chatId,
              rolloutId,
              slotId: context.slotId,
              forkId: context.forkId,
              connectionId,
              modelId,
              requestClass: context.requestClass,
              snapshot: JSON.stringify({ decision: { point: pointId, threshold, state, questions } })
            })
            let finished = false
            const finish = (
              status: "completed" | "failed" | "stopped",
              error: string | null,
              result: Record<string, unknown>
            ) =>
              writer
                .FinishDecisionRollout({
                  userId: context.userId,
                  rolloutId,
                  status,
                  error,
                  result: JSON.stringify(result)
                })
                .pipe(
                  Effect.catchCause((cause) => Effect.logError(`closing decision ${rolloutId} failed`, cause)),
                  Effect.ensuring(
                    Effect.sync(() => {
                      finished = true
                    })
                  )
                )
            return yield* Effect.gen(function* () {
              const sent = yield* providers
                .decide({
                  userId: context.userId,
                  connectionId,
                  modelId,
                  state,
                  questions,
                  attribution: { chatId: context.chatId, rolloutId }
                })
                .pipe(Effect.timeoutOption(timeoutMs), Effect.exit)
              if (Exit.isFailure(sent)) {
                const interrupted = Cause.hasInterruptsOnly(sent.cause)
                const failure = Option.getOrUndefined(Cause.findErrorOption(sent.cause))
                const message = failure?.message ?? "the request failed"
                yield* finish(interrupted ? "stopped" : "failed", interrupted ? null : message, {
                  source: "heuristic",
                  reason: "error"
                })
                if (interrupted) return yield* Effect.interrupt
                return fallback("error", rolloutId)
              }
              if (Option.isNone(sent.value)) {
                yield* finish("failed", `No answer within ${timeoutMs / 1000} s.`, {
                  source: "heuristic",
                  reason: "timeout"
                })
                return fallback("timeout", rolloutId)
              }
              const response = sent.value.value
              const answers = parseAnswers(response.answers, questions)
              if (!answers) {
                yield* finish("failed", "The decision model's answer didn't fit the questions.", {
                  source: "heuristic",
                  reason: "malformed",
                  servedModel: response.servedModel,
                  raw: response.answers ?? null
                })
                return fallback("malformed", rolloutId)
              }
              const value = point.resolve(answers, input, threshold)
              if (value === null) {
                yield* finish("completed", null, {
                  source: "heuristic",
                  reason: "low_confidence",
                  servedModel: response.servedModel,
                  answers
                })
                return fallback("low_confidence", rolloutId)
              }
              yield* finish("completed", null, { source: "model", servedModel: response.servedModel, answers, value })
              return { value, source: "model" as const, rolloutId }
            }).pipe(
              Effect.onExit((exit) => {
                if (finished || Exit.isSuccess(exit)) return Effect.void
                const interrupted = Cause.hasInterruptsOnly(exit.cause)
                return finish(
                  interrupted ? "stopped" : "failed",
                  interrupted ? null : "The decision could not be resolved.",
                  {
                    source: "heuristic",
                    reason: "error"
                  }
                )
              })
            )
          }).pipe(
            // Settings that can't be read, or a rollout that can't be written: the old way decides.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning(`decision ${pointId} fell back`, cause).pipe(Effect.as(fallback("unavailable")))
            )
          ) as Effect.Effect<DecisionOutcome<V>>
        }

        const afterReply: DecisionEngineShape["afterReply"] = (reply) =>
          Effect.forEach(
            points.list().filter((point) => point.afterReply),
            (point) =>
              point.afterReply!(reply, { reader, writer, evaluate }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.succeed(false)
                    : Effect.logWarning(`decision point ${point.id} after a reply failed`, cause).pipe(Effect.as(false))
                )
              )
          ).pipe(Effect.map((changed) => changed.some(Boolean)))

        const beforeReply: DecisionEngineShape["beforeReply"] = (reply) =>
          Effect.forEach(
            // A point the chat turned off does none of its work; `evaluate` refuses it besides.
            points
              .list()
              .filter((point) => point.beforeReply && !foldState(reply.events).decisionsOff?.includes(point.id)),
            (point) =>
              point.beforeReply!(reply, { reader, writer, evaluate }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause as Cause.Cause<never>)
                    : Effect.logWarning(`decision point ${point.id} before a reply failed`, cause).pipe(
                        Effect.as(false)
                      )
                )
              )
          ).pipe(Effect.map((changed) => changed.some(Boolean)))

        const skippedIn: DecisionEngineShape["skippedIn"] = (userId, turn) => {
          const off = turn.state.decisionsOff ?? []
          if (off.length === 0) return Effect.succeed([])
          return reader.GetDecisionSettings({ userId }).pipe(
            Effect.map((settings) =>
              points
                .list()
                .filter(
                  (point) =>
                    off.includes(point.id) &&
                    settings.some((entry) => entry.model !== null && entry.points[point.id]?.on === true) &&
                    (point.appliesTo?.(turn) ?? true)
                )
                .map((point) => ({ id: point.id, label: point.label, instead: point.instead ?? INSTEAD_DEFAULT }))
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("reading the decisions a chat turned off failed", cause).pipe(Effect.as([]))
            )
          )
        }

        return DecisionEngine.of({ points, evaluate, afterReply, beforeReply, skippedIn })
      })
    )

  static readonly layer = DecisionEngine.layerWith()
}
