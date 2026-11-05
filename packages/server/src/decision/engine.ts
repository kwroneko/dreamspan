// Decision models (DESIGN §7.6 [D]: integrated as in reference-harness, never mandatory, a heuristic
// fallback at each point; spec/AGENTIC.md §7). A delta from reference-harness's `src/decisions/registry.ts`:
// the same point shape (questions, state, resolve, fallback) and the same evaluate() ladder, with
// one connection per point instead of a model chain, and settings per connection instead of a
// `[decisions]` config block. Nothing is sent unless the user turned the point on for a
// connection (owner rule: provider sends are opt-in per connection). Each call is a rollout of
// kind `decision` with its ledger rows, so the Activity panel lists it with tokens and cost.
// Points are a registry: a plugin adds one, or replaces or removes a built-in, by its id.
import type { ChatId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import { type DecisionAnswers, type DecisionQuestion, parseAnswers } from "@rp/shared/decisions.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { Reader, Writer } from "../db/Database.ts"
import { Providers } from "../providers/Providers.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { builtinPoints } from "./points/index.ts"

/** The hard deadline of one decision call (AGENTIC §7: 10 s); past it the fallback decides. */
export const DECISION_TIMEOUT_MS = 10_000

/** Where a decision is made: the chat, and the message it decides for. */
export interface DecisionContext {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: SlotId | null
  readonly forkId: ForkId | null
  /** A decision a reply waits for is interactive; one after a reply is background. */
  readonly requestClass: "interactive" | "background"
}

/** A reply that just completed, for the points that act after one. */
export interface FinishedReply {
  readonly userId: UserId
  readonly chatId: ChatId
  readonly slotId: SlotId
  readonly versionId: VersionId
  readonly forkId: ForkId | null
}

export interface DecisionServices {
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly evaluate: DecisionEngineShape["evaluate"]
}

/** One decision point (reference-harness's `DecisionPoint<I, V>`). */
export interface DecisionPoint<I, V> {
  readonly id: string
  /** User-facing, for the connection's Decisions settings. */
  readonly label: string
  readonly description: string
  /** How sure the model must be, 0.5..1, unless the user sets it. */
  readonly defaultThreshold: number
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
}

/** A point with its input and verdict types erased, as the registry holds it. */
export type AnyDecisionPoint = DecisionPoint<never, unknown>

export type DecisionSource = "model" | "heuristic"

export interface DecisionOutcome<V> {
  readonly value: V
  readonly source: DecisionSource
  /** Why the fallback decided: `off`, `nothing_to_ask`, `timeout`, `error`, `malformed`, `low_confidence`, `unavailable`. */
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
}

export class DecisionEngine extends Context.Service<DecisionEngine, DecisionEngineShape>()("rp/decision/DecisionEngine") {
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
        const timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS

        /** The connection that answers this point: the first, by name, with it on and a model chosen. */
        const answering = (userId: UserId, pointId: string) =>
          Effect.gen(function* () {
            const settings = yield* reader.GetDecisionSettings({ userId })
            const on = settings.filter((entry) => entry.model !== null && entry.points[pointId]?.on === true)
            if (on.length === 0) return null
            if (on.length === 1) return on[0]!
            const names = new Map(
              (yield* reader.ListConnections({ userId })).map((connection) => [connection.id as string, connection.name])
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
          return Effect.gen(function* () {
            const entry = yield* answering(context.userId, pointId)
            // Off for every connection: nothing is built, nothing is sent.
            if (!entry) return fallback("off")
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
                .pipe(Effect.catchCause((cause) => Effect.logError(`closing decision ${rolloutId} failed`, cause)))
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
            // Settings that can't be read, or a rollout that can't be written: the old way decides.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning(`decision ${pointId} fell back`, cause).pipe(
                    Effect.as(fallback("unavailable"))
                  )
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

        return DecisionEngine.of({ points, evaluate, afterReply })
      })
    )

  static readonly layer = DecisionEngine.layerWith()
}
