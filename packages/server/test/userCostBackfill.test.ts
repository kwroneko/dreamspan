import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { environment } from "./support/backfillReview.ts"
import { lcmTest } from "./support/lcmHarness.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

for (const route of [false, true])
  lcmTest(`persisted ${route ? "upstream" : "model"} pricing cannot bypass backfill admission`, (server) =>
    Effect.gen(function* () {
      const h = yield* environment(server, ["Bob - custom"])
      const p = yield* h.prepare("Bob - custom")
      const at = { chatId: p.chatId, leafSlotId: p.leaf }
      const builtin = yield* h.api.GetLcmEnableOffer(at)
      const saved = yield* h.api.GetCostSettings()
      const rule = {
        id: "custom",
        name: "Custom",
        kind: "openai-chat",
        connectionId: null,
        model: "primary-model",
        upstream: null,
        currency: route ? "USD" : "credits",
        rates: { input: 10, read: 1, write: 0, writeLong: 20, output: 40 },
        tiers: []
      }
      yield* h.api.SetCostSettings({ expectedRevision: saved.revision, rules: [rule] })
      const offer = yield* h.api.GetLcmEnableOffer(at)
      assert.equal(offer.fromScratch.cost!.currency, rule.currency)
      assert.approximately(offer.fromScratch.cost!.amount, builtin.fromScratch.cost!.amount * 10, 1e-10)
      yield* h.api.EnableLcm({ ...at, choice: "scratch" })
      if (route) {
        // No matching generic rule at dispatch, and the route isn't known yet. This must
        // claim the bound rather than silently falling through to cheap catalog pricing.
        yield* h.api.SetCostSettings({
          expectedRevision: saved.revision + 1,
          rules: [{ ...rule, upstream: "Synthetic route", rates: { ...rule.rates, input: 1e9 } }]
        })
      }
      yield* fixtureSql(h.config.dataDir, [
        {
          sql: "UPDATE jobs SET payload_json = json_set(payload_json, '$.capCost', ?, '$.capTokens', 1000000) WHERE kind = 'lcm-backfill' AND json_extract(payload_json, '$.chatId') = ?",
          params: [route ? 10 : 1e-9, p.chatId]
        }
      ])
      yield* h.summarizer.planNow({ userId: h.userId, ...at }, "reply")
      const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.isNotNull(job)
      yield* h.summarizer.runJob(job!)
      assert.lengthOf(h.mock.requests(), 0, "held before a paid request reaches the provider")
      assert.equal((yield* h.api.GetLcmBackfill(at))!.state, "capped")
    }).pipe(Effect.scoped)
  )
