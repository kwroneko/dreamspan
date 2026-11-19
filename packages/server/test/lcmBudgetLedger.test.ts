import { assert } from "@effect/vitest"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { LlmRequestId } from "@dreamspan/shared/usage.ts"
import { Effect } from "effect"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { summaryJob } from "./support/lcmFixtures.ts"

lcmTest("atomic admission counts concurrent reservations, reconciles usage and retains crash exposure", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 1 })
    const leaf = h.rows[0]!.slotId
    yield* h.writer.EnableLcm({
      userId: h.userId,
      chatId: h.chat.id,
      leafSlotId: leaf,
      choice: "scratch",
      approved: { jobs: 1, tokens: 100, cost: 1, currency: "USD" }
    })
    const job = yield* summaryJob(h.dataDir, h.chat.id, leaf, leaf)
    const open = (tokens: number, cost: number, summary = true) =>
      Effect.gen(function* () {
        const id = uuidv7() as LlmRequestId
        const allowed = yield* h.writer.OpenLlmRequest({
          userId: h.userId,
          request: {
            id,
            connectionId: h.connection.id,
            modelId: h.primary.model,
            chatId: h.chat.id,
            rolloutId: summary ? job.rolloutId : null,
            versionId: null,
            purpose: "decision",
            api: "openai-completions",
            provider: "openai",
            modelKey: "primary-model",
            startedAt: Date.now(),
            reservation: { tokens, cost, currency: "USD" }
          }
        })
        return { id, allowed }
      })
    const [first, second] = yield* Effect.all([open(70, 0.7), open(70, 0.7)], { concurrency: 2 })
    assert.isTrue(first.allowed)
    assert.isTrue(second.allowed)
    assert.isFalse(
      (yield* open(20, 0.2)).allowed,
      "nothing completed, but the running requests already reserve 140/150 tokens and $1.40/$1.50"
    )
    assert.strictEqual((yield* h.reader.GetBackfill({ userId: h.userId, chatId: h.chat.id }))!.state, "capped")
    yield* h.writer.CloseLlmRequest({
      userId: h.userId,
      request: {
        id: first.id,
        status: "complete",
        endedAt: Date.now(),
        firstTokenAt: null,
        responseModel: null,
        upstream: null,
        counts: { inputUncached: 10, cacheRead: 0, cacheWrite: 0, cacheWriteLong: 0, output: 10, reasoning: null },
        usageSource: "reported",
        rawUsage: null,
        reportedCost: null,
        cost: { amount: 0.2, currency: "USD", formula: "fixture" },
        error: null
      }
    })
    yield* h.writer.InterruptRunningLlmRequests()
    const recovered = yield* h.reader.GetBackfill({ userId: h.userId, chatId: h.chat.id })
    assert.closeTo(recovered!.spentCost!, 0.9, 1e-12)
    assert.strictEqual(
      recovered!.spentTokens,
      90,
      "the interrupted request may have been billed; its reservation survives"
    )
    assert.isTrue((yield* open(10000, 100, false)).allowed, "a narrator decision in the same chat has its own budget")
    yield* h.writer.InterruptRunningLlmRequests()
    const isolated = yield* h.reader.GetBackfill({ userId: h.userId, chatId: h.chat.id })
    assert.closeTo(isolated!.spentCost!, 0.9, 1e-12)
    assert.strictEqual(isolated!.spentTokens, 90)
  }).pipe(Effect.scoped)
)
