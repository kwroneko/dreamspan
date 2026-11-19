import { assert } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { vi } from "vitest"
import { eventually } from "./support/generation.ts"
import { environment } from "./support/backfillReview.ts"
import { lcmTest } from "./support/lcmHarness.ts"
import { completionChunks, sse } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { LcmEstimateChanged } from "@dreamspan/shared/lcm.ts"
import { posted } from "./support/config.ts"
const flat = (x: unknown) =>
  typeof x === "string" ? x : ((x ?? []) as Array<{ text?: string }>).map((p) => p.text ?? "").join("")

lcmTest("Enable refuses a higher replacement estimate until its new figures are approved", (server) =>
  Effect.gen(function* () {
    const h = yield* environment(server, ["Bob - approval"])
    const p = yield* h.prepare("Bob - approval")
    const a = { chatId: p.chatId, leafSlotId: p.leaf }
    const offer = yield* h.api.GetLcmEnableOffer(a)
    yield* fixtureSql(server.config.dataDir, [
      {
        sql: "UPDATE models SET upstream_json=? WHERE id=?",
        params: [
          JSON.stringify({ price: { input: 1000, output: 4000, cacheRead: 100, cacheWrite: 0 } }),
          offer.fromScratch.model!.model
        ]
      }
    ])
    const enabled = yield* Effect.flip(h.api.EnableLcm({ ...a, choice: "scratch", approved: offer.fromScratch }))
    assert.instanceOf(enabled, LcmEstimateChanged)
    assert.isAbove((enabled as LcmEstimateChanged).estimate.cost!.amount, offer.fromScratch.cost!.amount)
    assert.isNull(yield* h.api.GetLcmBackfill(a))
    const refreshed = yield* h.api.GetLcmEnableOffer(a)
    const accepted = yield* h.api.EnableLcm({ ...a, choice: "scratch", approved: refreshed.fromScratch })
    assert.closeTo(accepted!.capCost!, refreshed.fromScratch.cost!.amount * 1.5, 1e-12)
  }).pipe(Effect.scoped)
)

lcmTest("concurrent leaf and condensation requests keep charged plus reserved spend below the cap", (server) =>
  Effect.gen(function* () {
    const h = yield* environment(
      server,
      ["Bob - concurrent"],
      (req, res) => {
        const ms = req.body?.messages as Array<{ content: unknown }>
        const cond = flat(ms.at(-1)?.content).includes("Condense the last")
        const n = cond ? 375 : 250
        setTimeout(
          () =>
            sse(
              res,
              completionChunks(["Summary. ".padEnd(n * 4, "s")], {
                prompt_tokens: ms.reduce((s, m) => s + Math.ceil(flat(m.content).length / 4) + 3, 0),
                completion_tokens: n
              })
            ),
          60
        )
      },
      { hidden: 20, visible: 180 }
    )
    const p = yield* h.prepare("Bob - concurrent")
    const a = { chatId: p.chatId, leafSlotId: p.leaf }
    yield* h.api.EnableLcm({ ...a, choice: "scratch" })
    const pairs: Array<{ levels: number[]; spent: number | null; cap: number | null }> = []
    let state: import("@dreamspan/shared/lcm.ts").LcmBackfill | null = null
    for (let pass = 0; pass < 100; pass++) {
      yield* h.summarizer.planNow({ userId: h.userId, ...a }, pass === 0 ? "reply" : "completion")
      const j1 = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      if (!j1) break
      const j2 = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      if (j2) {
        const before = yield* h.api.GetLcmBackfill(a)
        pairs.push({ levels: [j1.level, j2.level], spent: before!.spentCost, cap: before!.capCost })
      }
      yield* Effect.all([h.summarizer.runJob(j1), ...(j2 ? [h.summarizer.runJob(j2)] : [])], { concurrency: 2 })
      state = yield* h.api.GetLcmBackfill(a)
      assert.isAtMost(state!.spentCost ?? 0, state!.capCost!)
      if (state!.state === "capped") break
    }
    assert.isAbove(pairs.length, 0)
    assert.strictEqual(state!.state, "capped")
    assert.isAtMost(state!.spentCost!, state!.capCost!)
  }).pipe(Effect.scoped)
)

for (const held of ["pause", "cap"] as const)
  lcmTest(
    `a ${held} during an existing summary wait releases the send`,
    (server) =>
      Effect.gen(function* () {
        const pending: Array<() => void> = []
        const h = yield* environment(
          server,
          ["Bob - wait"],
          (req, res) => {
            const ms = req.body?.messages as Array<{ content: unknown }>
            const isSummary = flat(ms.at(-1)?.content).includes("summar")
            const done = () =>
              sse(res, completionChunks(["A synthetic answer."], { prompt_tokens: 800, completion_tokens: 5 }))
            if (isSummary) pending.push(done)
            else done()
          },
          { hidden: 20, visible: 100 }
        )
        const p = yield* h.prepare("Bob - wait")
        const a = { chatId: p.chatId, leafSlotId: p.leaf }
        yield* h.api.EnableLcm({ ...a, choice: "scratch" })
        yield* h.api.SetLcmBackfill({ ...a, action: "summarizeNow" })
        yield* eventually(() => pending.length > 0)
        const waiting = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        // Escalation happens inside the real runway wait, after planning found
        // unfinished summaries. Observe it instead of assuming 500 ms was enough.
        const escalate = h.writer.EscalateSummaryJob
        const escalated = vi
          .spyOn(h.writer, "EscalateSummaryJob")
          .mockImplementation((args) => escalate(args).pipe(Effect.tap(() => Deferred.succeed(waiting, undefined))))
        const beforeReply = h.summarizer.beforeReply
        const finishedWait = vi
          .spyOn(h.summarizer, "beforeReply")
          .mockImplementation((args) => beforeReply(args).pipe(Effect.tap(() => Deferred.succeed(released, undefined))))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            escalated.mockRestore()
            finishedWait.mockRestore()
            for (const done of pending.splice(0)) done()
          })
        )
        // Exercise the actual generation RPC while the first summary request is in flight.
        const generated = yield* posted(
          h.api.Generate({
            chatId: p.chatId,
            parentSlotId: p.leaf,
            branch: false,
            speakerEntityId: null
          })
        )
        yield* Deferred.await(waiting)
        if (held === "pause") yield* h.api.SetLcmBackfill({ ...a, action: "pause" })
        else {
          yield* fixtureSql(server.config.dataDir, [
            {
              sql: "UPDATE jobs SET payload_json=json_set(payload_json,'$.capped',json('true')) WHERE kind='lcm-backfill' AND json_extract(payload_json,'$.chatId')=?",
              params: [p.chatId]
            }
          ])
        }
        // The pause/cap must release before any held summary is answered.
        yield* Deferred.await(released)
        for (const done of pending.splice(0)) done()
        const completed = (slotId: typeof p.leaf) =>
          Effect.gen(function* () {
            for (;;) {
              const slot = yield* h.reader.GetSlot({ userId: h.userId, slotId })
              if (slot.entry.version.status !== "generating") {
                assert.strictEqual(slot.entry.version.status, "complete")
                assert.isNotEmpty(slot.entry.version.content)
                return
              }
              yield* Effect.sleep(10)
            }
          })
        yield* completed(generated.entry.slotId)
        const state = yield* h.api.GetLcmBackfill(a)
        assert.strictEqual(state!.state, held === "pause" ? "paused" : "capped")

        // A new send begun while already paused goes through promptly.
        const next = yield* posted(
          h.api.Generate({
            chatId: p.chatId,
            parentSlotId: generated.entry.slotId,
            branch: false,
            speakerEntityId: null
          })
        )
        yield* completed(next.entry.slotId)
      }).pipe(Effect.scoped),
    { pool: true, timeout: 60000 }
  )

lcmTest("Continue refuses a higher remaining estimate and preserves the existing cap", (server) =>
  Effect.gen(function* () {
    const h = yield* environment(server, ["Bob - continue approval"])
    const p = yield* h.prepare("Bob - continue approval")
    const at = { chatId: p.chatId, leafSlotId: p.leaf }
    yield* h.api.EnableLcm({ ...at, choice: "scratch" })
    const paused = yield* h.api.SetLcmBackfill({ ...at, action: "pause" })
    yield* fixtureSql(h.config.dataDir, [
      {
        sql: "UPDATE models SET upstream_json=? WHERE id=?",
        params: [
          JSON.stringify({ price: { input: 1000, output: 4000, cacheRead: 100 } }),
          paused!.remaining.model!.model
        ]
      }
    ])
    const refused = yield* Effect.flip(h.api.SetLcmBackfill({ ...at, action: "continue", approved: paused!.remaining }))
    assert.instanceOf(refused, LcmEstimateChanged)
    const stillPaused = yield* h.api.GetLcmBackfill(at)
    assert.strictEqual(stillPaused!.state, "paused")
    assert.strictEqual(stillPaused!.capCost, paused!.capCost)
    assert.isAbove(stillPaused!.remaining.cost!.amount, paused!.remaining.cost!.amount)
  }).pipe(Effect.scoped)
)
