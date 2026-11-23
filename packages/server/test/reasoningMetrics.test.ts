// A reply's reasoning in its metrics (reasoningstats1): the provider's reasoning count when its
// usage has one, the app's count of the streamed thinking (an estimate) when it doesn't, and the
// first reasoning and reply tokens timed apart, all kept on the ledger row and frozen once closed.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { sse, startMockProvider } from "./support/mockProvider.ts"

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finish }]
})
const usage = (details: boolean) => ({
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 60,
    ...(details ? { completion_tokens_details: { reasoning_tokens: 45 } } : {})
  }
})

const run = (details: boolean) => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_request, res) =>
          sse(res, [
            chunk({ role: "assistant", reasoning_content: "Mira weighs the ledger against the rain." }),
            chunk({ content: "The north road." }),
            chunk({}, "stop"),
            usage(details)
          ])
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { version } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: { prefill: "assistant" }
    })
    const [metrics] = yield* api.GetVersionMetrics({ versionIds: [version.id] })
    return { config, metrics: metrics! }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
}

describe("reasoning metrics", () => {
  it.live("keeps the provider's reasoning count and times reasoning and reply apart", () =>
    Effect.gen(function* () {
      const { metrics } = yield* run(true)
      assert.strictEqual(metrics.output, 60)
      assert.strictEqual(metrics.reasoning, 45)
      assert.isFalse(metrics.reasoningEstimated)
      assert.isTrue(metrics.reasoningStreamed)
      const { firstReasoningAt, firstReplyAt, firstTokenAt } = metrics.last
      assert.isNumber(firstReasoningAt)
      assert.isNumber(firstReplyAt)
      assert.strictEqual(firstTokenAt, firstReasoningAt)
      assert.isAtLeast(firstReplyAt!, firstReasoningAt!)
    })
  )

  it.live("counts the streamed thinking itself, as an estimate, when the usage has no count", () =>
    Effect.gen(function* () {
      const { metrics } = yield* run(false)
      assert.isTrue(metrics.reasoningEstimated)
      assert.isAbove(metrics.reasoning!, 0)
      assert.isAtMost(metrics.reasoning!, 60)
    })
  )

  it.live("freezes the new figures on a closed row", () =>
    Effect.gen(function* () {
      const { config } = yield* run(true)
      const attempt = yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE llm_requests SET first_reply_at = 1, reasoning_estimated = 1", params: [] }
      ]).pipe(Effect.flip)
      assert.include(String((attempt as { cause?: unknown }).cause), "a closed request is a record")
    })
  )
})
