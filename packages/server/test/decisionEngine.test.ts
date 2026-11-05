// The decision engine's ladder (spec/AGENTIC.md §7), ported from reference-harness's engine tests
// (`test/decisions.test.ts`): a point that's off sends nothing; a model verdict; low confidence,
// a malformed answer, a failed request and a timeout each fall back with their reason, and each
// sent request is a decision rollout that's closed. Fake storage and provider: no real calls.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import { parseAnswers, unwrapEnvelope } from "@rp/shared/decisions.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { ConnectionId, ModelId } from "@rp/shared/providers.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { type DecisionPoint, DecisionEngine } from "../src/decision/engine.ts"
import { providerError } from "../src/providers/errors.ts"
import { Providers } from "../src/providers/Providers.ts"

const point: DecisionPoint<{ readonly asked: boolean }, string> = {
  id: "probe",
  label: "Probe",
  description: "A test point.",
  defaultThreshold: 0.8,
  questions: ({ asked }) => (asked ? { q: { type: "noul", instructions: "It holds." } } : {}),
  state: () => ({ recent: [] }),
  resolve: (answers, _input, threshold) => {
    const a = answers["q"]
    return a?.type === "noul" && a.noul >= threshold ? "model" : null
  },
  fallback: () => "fallback"
}

const context = {
  userId: "user_1" as UserId,
  chatId: "chat_1" as ChatId,
  slotId: null,
  forkId: null,
  requestClass: "interactive" as const
}

const harness = (options: {
  readonly on?: boolean
  readonly answer: Effect.Effect<unknown, ReturnType<typeof providerError>>
  readonly timeoutMs?: number
}) => {
  const started: Array<string> = []
  const finished: Array<{ status: string; error: string | null; result: Record<string, unknown> }> = []
  let sent = 0
  const reader = Layer.succeed(Reader, {
    GetDecisionSettings: () =>
      Effect.succeed([
        {
          connectionId: "connection_1" as ConnectionId,
          model: "model_1" as ModelId,
          points: { probe: { on: options.on ?? true, threshold: 0.8 } }
        }
      ])
  } as never)
  const writer = Layer.succeed(Writer, {
    StartDecisionRollout: ({ rolloutId }: { rolloutId: string }) => Effect.sync(() => void started.push(rolloutId)),
    FinishDecisionRollout: (f: { status: string; error: string | null; result: string }) =>
      Effect.sync(() => void finished.push({ status: f.status, error: f.error, result: JSON.parse(f.result) }))
  } as never)
  const providers = Layer.succeed(Providers, {
    decide: () =>
      Effect.suspend(() => {
        sent++
        return options.answer.pipe(
          Effect.map((answers) => ({
            requestId: "llm_request_1",
            answers,
            servedModel: "jev-dated",
            counts: {},
            cost: null
          }))
        )
      })
  } as never)
  const layer = DecisionEngine.layerWith({ points: [point], timeoutMs: options.timeoutMs ?? 1_000 }).pipe(
    Layer.provide([reader, writer, providers])
  )
  const run = (asked = true) =>
    Effect.flatMap(DecisionEngine, (engine) =>
      engine.evaluate<{ asked: boolean }, string>("probe", { asked }, context)
    ).pipe(Effect.provide(layer))
  return { run, started, finished, sent: () => sent }
}

describe("decision engine", () => {
  it("parseAnswers: typed answers; a missing or malformed answer fails the whole map", () => {
    const questions = {
      task: { type: "choice" as const, instructions: "x", criteria: { coding: "c", chat: "d" } },
      open: { type: "noul" as const, instructions: "y" }
    }
    const ok = { task: { choice: "coding", confidence: 0.9, probabilities: { coding: 0.9 } }, open: { noul: 0.7 } }
    assert.deepStrictEqual(parseAnswers(ok, questions), {
      task: { type: "choice", choice: "coding", probabilities: { coding: 0.9 }, confidence: 0.9 },
      open: { type: "noul", noul: 0.7 }
    })
    assert.isUndefined(parseAnswers({ task: ok.task }, questions), "missing answer")
    assert.isUndefined(parseAnswers({ ...ok, task: { choice: "nope", confidence: 0.9 } }, questions), "unknown option")
    assert.isUndefined(parseAnswers({ ...ok, open: { noul: 1.4 } }, questions), "not a probability")
    const score = { d: { type: "score" as const, instructions: "x", criteria: ["a", "b", "c"] } }
    assert.deepInclude(parseAnswers({ d: { score: "2", confidence: 0.5 } }, score)?.["d"], { score: 2 })
    assert.isUndefined(parseAnswers({ d: { score: 3, confidence: 0.5 } }, score), "score out of range")
  })

  it("unwrapEnvelope accepts the bare body and Cloudflare's { result } envelope", () => {
    assert.deepStrictEqual(unwrapEnvelope({ answers: {}, model: "m" }), { answers: {}, model: "m" })
    assert.deepStrictEqual(unwrapEnvelope({ result: { answers: { a: 1 } }, success: true }), { answers: { a: 1 } })
  })

  it.effect("a point that's off returns the fallback without a request or a rollout", () =>
    Effect.gen(function* () {
      const h = harness({ on: false, answer: Effect.succeed({ q: { noul: 0.99 } }) })
      assert.deepStrictEqual(yield* h.run(), { value: "fallback", source: "heuristic", reason: "off" })
      assert.strictEqual(h.sent(), 0)
      assert.deepStrictEqual(h.started, [])
    })
  )

  it.effect("nothing to ask: no request", () =>
    Effect.gen(function* () {
      const h = harness({ answer: Effect.succeed({}) })
      assert.deepInclude(yield* h.run(false), { value: "fallback", reason: "nothing_to_ask" })
      assert.strictEqual(h.sent(), 0)
    })
  )

  it.effect("a sure answer is the model's verdict, its rollout completed", () =>
    Effect.gen(function* () {
      const h = harness({ answer: Effect.succeed({ q: { noul: 0.9 } }) })
      const outcome = yield* h.run()
      assert.deepInclude(outcome, { value: "model", source: "model" })
      assert.strictEqual(outcome.rolloutId, h.started[0])
      assert.deepInclude(h.finished[0], { status: "completed", error: null })
      assert.strictEqual(h.finished[0]!.result["source"], "model")
    })
  )

  it.effect("low confidence falls back; the answered request is still a completed rollout", () =>
    Effect.gen(function* () {
      const h = harness({ answer: Effect.succeed({ q: { noul: 0.6 } }) })
      assert.deepInclude(yield* h.run(), { value: "fallback", source: "heuristic", reason: "low_confidence" })
      assert.deepInclude(h.finished[0], { status: "completed" })
    })
  )

  it.effect("a malformed answer falls back, and its rollout failed", () =>
    Effect.gen(function* () {
      const h = harness({ answer: Effect.succeed({ q: { noul: "yes" } }) })
      assert.deepInclude(yield* h.run(), { value: "fallback", reason: "malformed" })
      assert.deepInclude(h.finished[0], { status: "failed" })
    })
  )

  it.effect("a failed request falls back with reason error", () =>
    Effect.gen(function* () {
      const h = harness({ answer: Effect.fail(providerError("rate_limited", "HTTP 429")) })
      assert.deepInclude(yield* h.run(), { value: "fallback", reason: "error" })
      assert.deepInclude(h.finished[0], { status: "failed", error: "HTTP 429" })
    })
  )

  it.live("no answer within the deadline falls back with reason timeout", () =>
    Effect.gen(function* () {
      const h = harness({ answer: Effect.never, timeoutMs: 50 })
      assert.deepInclude(yield* h.run(), { value: "fallback", reason: "timeout" })
      assert.deepInclude(h.finished[0], { status: "failed", error: "No answer within 0.05 s." })
    })
  )
})
