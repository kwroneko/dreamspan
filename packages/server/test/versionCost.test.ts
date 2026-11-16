// A reply's cost and input counts in its metrics (msgcost1): `GetVersionMetrics` carries what
// the usage ledger stored for each generation request (cost, currency and formula, the
// provider's reported charge, uncached input, cache reads and writes), summed over the requests
// behind the version's text, never adding up currencies or counting a missing cost as zero.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { sse, startMockProvider } from "./support/mockProvider.ts"

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finish }]
})

// An OpenAI-compatible usage chunk with cached input and the provider's own charge, as
// OpenRouter reports it.
const usage = {
  id: "cmpl-1",
  object: "chat.completion.chunk",
  model: "served-model",
  choices: [],
  usage: {
    prompt_tokens: 1_200,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 1_000 },
    cost: 0.0021
  }
}

describe("version cost metrics", () => {
  it.live("carries the ledger's cost, reported charge and cache counts, summed over a continuation", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(res, [chunk({ role: "assistant", content: "The ledger" }), chunk({}, "stop"), usage])
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version, chat, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: { prefill: "assistant" }
      })
      assert.strictEqual(version.status, "complete")
      const [one] = yield* api.GetVersionMetrics({ versionIds: [version.id] })
      assert.deepStrictEqual(one!.costs, [{ amount: 0.0021, currency: "USD" }])
      assert.deepStrictEqual(one!.costSources, ["reported"])
      assert.strictEqual(one!.costUnknown, 0)
      assert.isFalse(one!.costEstimated)
      assert.strictEqual(one!.reportedCost, 0.0021)
      assert.strictEqual(one!.reportedRequests, 1)
      assert.strictEqual(one!.inputUncached, 200)
      assert.strictEqual(one!.cacheRead, 1_000)
      assert.strictEqual(one!.cacheWrite, 0)
      assert.deepStrictEqual(one!.last.cost, { amount: 0.0021, currency: "USD", formula: "reported" })
      assert.strictEqual(one!.last.reportedCost, 0.0021)

      // Continued: both requests count.
      const entry = (yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })).entries.at(-1)!
      const continued = yield* api.ContinueVersion({ versionId: version.id, expectedRowVersion: entry.rowVersion })
      yield* eventually(() => finished(events, continued.version.id) !== undefined)
      const [two] = yield* api.GetVersionMetrics({ versionIds: [continued.version.id] })
      assert.strictEqual(two!.requests, 2)
      assert.strictEqual(two!.costs.length, 1)
      assert.closeTo(two!.costs[0]!.amount, 0.0042, 1e-12)
      assert.closeTo(two!.reportedCost!, 0.0042, 1e-12)
      assert.strictEqual(two!.cacheRead, 2_000)
      assert.strictEqual(two!.inputUncached, 400)

      // Recomputed costs (the only columns a closed request lets change): one in another
      // currency by the user's formula, one with none. They're kept apart, never added up.
      const ids = (yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT id FROM llm_requests WHERE version_id IN (?, ?) ORDER BY started_at, id",
            params: [version.id, continued.version.id]
          }
        ],
        { readOnly: true }
      ))[0]!.map((row) => row["id"] as string)
      assert.strictEqual(ids.length, 2)
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE llm_requests SET cost = NULL, cost_currency = NULL, cost_formula = NULL WHERE id = ?",
          params: [ids[0]!]
        },
        {
          sql: "UPDATE llm_requests SET cost = 0.5, cost_currency = 'EUR', cost_formula = 'user:rule:2' WHERE id = ?",
          params: [ids[1]!]
        }
      ])
      const [three] = yield* api.GetVersionMetrics({ versionIds: [continued.version.id] })
      assert.deepStrictEqual(three!.costs, [{ amount: 0.5, currency: "EUR" }])
      assert.strictEqual(three!.costUnknown, 1)
      assert.deepStrictEqual(three!.costSources, ["user:rule:2"])
      // The provider's charge is the record, untouched by the recompute.
      assert.closeTo(three!.reportedCost!, 0.0042, 1e-12)
      assert.deepStrictEqual(three!.last.cost, { amount: 0.5, currency: "EUR", formula: "user:rule:2" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
