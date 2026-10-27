import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { environment } from "./support/backfillReview.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmTest } from "./support/lcmHarness.ts"

for (const phase of ["reply", "completion"] as const)
  lcmTest(`an imported summary's explicit ${phase} work reserves against the backfill cap`, (server) =>
    Effect.gen(function* () {
      const h = yield* environment(
        server,
        ["Bob - continuation"],
        undefined,
        { hidden: 640, visible: 100 },
        (files) =>
          new Map(
            [...files].map(([name, bytes]) => {
              if (!name.endsWith(".jsonl")) return [name, bytes]
              const rows = new TextDecoder().decode(bytes).trim().split("\n")
              for (let i = 1; i <= 640; i++) {
                const row = JSON.parse(rows[i]!)
                row.mes = `Line ${i}.`
                rows[i] = JSON.stringify(row)
              }
              return [name, new TextEncoder().encode(rows.join("\n") + "\n")]
            })
          )
      )
      const p = yield* h.prepare("Bob - continuation")
      const at = { chatId: p.chatId, leafSlotId: p.leaf }
      const position = { userId: h.userId, ...at }
      const offer = yield* h.api.GetLcmEnableOffer(at)
      yield* h.api.EnableLcm({
        ...at,
        choice: "adopt",
        approved: { ...offer.adopted!, uncachedInput: 1_000_000, cost: { amount: 10, currency: "USD" } }
      })
      const defaults = yield* h.api.GetGenerationDefaults()
      yield* h.api.SetGenerationDefaults({ defaults: { ...defaults, lcm: { ...defaults.lcm, spendAhead: false } } })
      // The imported chat copied the default when it was made: its own setting changes too.
      yield* h.api.ChangeLcmSettings({ chatId: p.chatId, change: { when: "next-reply" } })
      const source = (yield* h.api.GetLcmState(at)).layer[0]!
      yield* h.api.SetSummaryRerun({
        chatId: p.chatId,
        target: { _tag: "Summary", summaryId: source.id },
        requested: true
      })
      const first = yield* h.summarizer.planNow(position, "reply")
      assert.lengthOf(first, 4)
      if (phase === "completion") {
        for (let i = 0; i < 4; i++) {
          const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
          assert.isNotNull(job, "explicit work bypasses spending ahead")
          yield* h.summarizer.runJob(job!)
        }
        // The fifth bounded part was authorized by the reply and survives recovery.
        yield* h.writer.ResetSummaryJobs()
        const continued = yield* h.summarizer.planNow(position, "completion")
        assert.lengthOf(continued, 1)
      }
      const before = yield* h.api.GetLcmBackfill(at)
      const calls = h.mock.requests().length
      assert.strictEqual(calls, phase === "reply" ? 0 : 4)
      yield* fixtureSql(server.config.dataDir, [
        {
          sql: "UPDATE jobs SET payload_json=json_set(payload_json,'$.capCost',?) WHERE kind='lcm-backfill' AND json_extract(payload_json,'$.chatId')=?",
          params: [(before!.spentCost ?? 0) + 0.000001, p.chatId]
        }
      ])
      const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.isNotNull(job, "a claim below the cap still needs a full dispatch reservation")
      yield* h.summarizer.runJob(job!)
      assert.lengthOf(h.mock.requests(), calls, "an explicit request cannot dispatch beyond the allowance")
      const after = yield* h.api.GetLcmBackfill(at)
      assert.strictEqual(after!.state, "capped")
      assert.isAtMost(after!.spentCost ?? 0, after!.capCost!)
      yield* h.writer.ResetSummaryJobs()
      yield* h.summarizer.planNow(position, "completion")
      assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }))
      assert.lengthOf(h.mock.requests(), calls)
    }).pipe(Effect.scoped)
  )
