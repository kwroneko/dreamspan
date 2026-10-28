import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { environment } from "./support/backfillReview.ts"
import { lcmTest } from "./support/lcmHarness.ts"
import { completionChunks, sse } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
const flat = (x: unknown) =>
  typeof x === "string" ? x : ((x ?? []) as Array<{ text?: string }>).map((p) => p.text ?? "").join("")

lcmTest("cap cold cache and maximum allowed output", (server) =>
  Effect.gen(function* () {
    const h = yield* environment(
      server,
      ["Bob - cold"],
      (req, res) => {
        const ms = req.body?.messages as Array<{ content: unknown }>
        const cond = flat(ms.at(-1)?.content).includes("Condense the last")
        const n = cond ? 375 : 250
        sse(
          res,
          completionChunks(["Summary. ".padEnd(n * 4, "s")], {
            prompt_tokens: ms.reduce((s, m) => s + Math.ceil(flat(m.content).length / 4) + 3, 0),
            completion_tokens: n
          })
        )
      },
      { hidden: 20, visible: 180 }
    )
    const p = yield* h.prepare("Bob - cold")
    const args = { chatId: p.chatId, leafSlotId: p.leaf }
    yield* h.api.GetLcmEnableOffer(args)
    yield* h.api.EnableLcm({ ...args, choice: "scratch" })
    yield* h.settle(p.chatId, p.leaf)
    const state = yield* h.api.GetLcmBackfill(args)
    assert.isAtMost(state!.spentCost!, state!.capCost!)
    assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }))
  }).pipe(Effect.scoped)
)

lcmTest("judge spend omitted even across refusal retries", (server) =>
  Effect.gen(function* () {
    const h = yield* environment(server, ["Bob - judge"], (req, res) => {
      const judge = req.body?.model === "judge-model"
      const ms = req.body?.messages as Array<{ content: unknown }>
      sse(
        res,
        completionChunks([judge ? "REFUSED" : "A useful summary."], {
          prompt_tokens: ms.reduce((s, m) => s + Math.ceil(flat(m.content).length / 4) + 3, 0),
          completion_tokens: judge ? 2 : 5
        })
      )
    })
    const defaults = yield* h.api.GetGenerationDefaults()
    const judge = yield* h.api.AddUserModel({
      connectionId: defaults.model!.connection,
      key: "judge-model",
      overrides: { context: 8192 }
    })
    yield* fixtureSql(server.config.dataDir, [
      {
        sql: "UPDATE models SET upstream_json = ? WHERE id = ?",
        params: [JSON.stringify({ price: { input: 1000, output: 4000, cacheRead: 100, cacheWrite: 0 } }), judge.id]
      }
    ])
    yield* h.api.SetGenerationDefaults({
      defaults: { ...defaults, judge: { connection: defaults.model!.connection, model: judge.id } }
    })
    const p = yield* h.prepare("Bob - judge")
    const args = { chatId: p.chatId, leafSlotId: p.leaf }
    yield* h.api.EnableLcm({ ...args, choice: "scratch" })
    yield* h.summarizer.planNow({ userId: h.userId, ...args }, "reply")
    for (let i = 0; i < 2; i++) {
      const j = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.isNotNull(j)
      yield* h.summarizer.runJob(j!)
    }
    const state = yield* h.api.GetLcmBackfill(args)
    const ledger = (yield* h.api.ListLlmRequests({ limit: 1000, before: null })).filter((r) => r.chatId === p.chatId)
    const actual = ledger.reduce((s, r) => s + (r.cost?.amount ?? 0), 0)
    assert.isAtMost(actual, state!.capCost!)
    // Both sum the same costs, in different orders: equal up to float rounding.
    assert.closeTo(state!.spentCost!, actual, 1e-9)
  }).pipe(Effect.scoped)
)
