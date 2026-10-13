import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { environment } from "./support/backfillReview.ts"
import { lcmTest } from "./support/lcmHarness.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { sse } from "./support/mockProvider.ts"
import { builtinCostFormulas } from "../src/providers/usage.ts"
;(builtinCostFormulas as import("../src/providers/registry.ts").CostFormula[]).push({
  id: "review-flat-fee",
  appliesTo: (t) => t.kind === "openai-chat",
  cost: () => ({ amount: 1, currency: "EUR" }),
  upperBound: () => ({ amount: 1, currency: "EUR" })
})
lcmTest("backfill estimate sums the formula for each planned request", (server) =>
  Effect.gen(function* () {
    const h = yield* environment(server, ["Bob - flat"])

    const p = yield* h.prepare("Bob - flat")
    const a = { chatId: p.chatId, leafSlotId: p.leaf }
    const offer = yield* h.api.GetLcmEnableOffer(a)
    yield* h.api.EnableLcm({ ...a, choice: "scratch" })
    yield* h.summarizer.planNow({ userId: h.userId, ...a }, "reply")
    for (let n = 0; n < 2; n++) {
      const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.isNotNull(job)
      yield* h.summarizer.runJob(job!)
    }
    const state = yield* h.api.GetLcmBackfill(a)
    assert.strictEqual(offer.fromScratch.cost!.amount, offer.fromScratch.l1Jobs + offer.fromScratch.condensations)
    assert.isAbove(offer.fromScratch.l1Jobs + offer.fromScratch.condensations, 1)
    assert.strictEqual(state!.spentCost, 2)
    assert.strictEqual(state!.capCost, offer.fromScratch.cost!.amount * 1.5)
  }).pipe(Effect.scoped)
)

for (const mode of ["tool", "retry"] as const)
  lcmTest(`each extra ${mode} request needs a reservation before dispatch`, (server) =>
    Effect.gen(function* () {
      const h = yield* environment(server, ["Bob - turns"], (_request, response) => {
        if (mode === "retry") {
          response.writeHead(503, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "Synthetic retry" } }))
          return
        }
        sse(response, [
          {
            id: "tool",
            object: "chat.completion.chunk",
            model: "synthetic",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "create",
                      type: "function",
                      function: {
                        name: "summary_tool",
                        arguments: JSON.stringify({ command: "create", file_text: "Synthetic draft.", finalize: false })
                      }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          {
            id: "tool",
            object: "chat.completion.chunk",
            model: "synthetic",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 100, completion_tokens: 10 }
          }
        ])
      })
      const p = yield* h.prepare("Bob - turns")
      const at = { chatId: p.chatId, leafSlotId: p.leaf }
      if (mode === "tool")
        yield* h.writer.AddStateEvent({
          userId: h.userId,
          chatId: p.chatId,
          slotId: null,
          versionId: null,
          scope: null,
          data: {
            key: "lcm.settings",
            value: { enabled: false, style: "tool", leafInput: 600, leafTarget: 100, fanout: 3, condenseTarget: 150 }
          }
        })
      yield* h.api.EnableLcm({ ...at, choice: "scratch" })
      yield* fixtureSql(h.config.dataDir, [
        {
          sql: "UPDATE jobs SET payload_json = json_set(payload_json, '$.capCost', 1.5, '$.capTokens', 1000000) WHERE kind = 'lcm-backfill' AND json_extract(payload_json, '$.chatId') = ?",
          params: [p.chatId]
        }
      ])
      yield* h.summarizer.planNow({ userId: h.userId, ...at }, "reply")
      const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.isNotNull(job)
      yield* h.summarizer.runJob(job!)
      assert.lengthOf(
        h.mock.requests(),
        1,
        "the next tool turn or provider retry is held before it reaches the provider"
      )
      const status = yield* h.api.GetLcmBackfill(at)
      assert.strictEqual(status!.state, "capped")
      assert.strictEqual(status!.spentCost, 1)
      const jobs = yield* h.api.GetLcmState(at)
      assert.lengthOf(jobs.failed, 0, "budget holds release jobs rather than spending their retry allowance")
    }).pipe(Effect.scoped)
  )
