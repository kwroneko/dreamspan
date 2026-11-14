import { assert, it } from "@effect/vitest"
import { Context, Deferred, Effect, Layer, Schema, type Scope } from "effect"
import { AppConfig } from "../src/config.ts"
import { ChatHub } from "../src/chat/ChatHub.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { SummaryChecks } from "../src/lcm/OutputChecks.ts"
import { makeSummarizer, Summarizer } from "../src/lcm/Summarizer.ts"
import { Providers } from "../src/providers/Providers.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { fixtureSql, summaryJob } from "./support/lcmFixtures.ts"

lcmTest("jobs without a stored leaf use their range endpoint when planned and claimed", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server)
    const first = h.rows[0]!.slotId,
      last = h.rows.at(-1)!.slotId
    // The schema permits this row. completeFixture also leaves one processing
    // between its fixture-worker insert and the writer's completion.
    const fixture = yield* summaryJob(h.dataDir, h.chat.id, first, last)
    const plan = yield* h.reader.PlanSummaries({ userId: h.userId, chatId: h.chat.id, leafSlotId: last })
    assert.strictEqual(plan.jobs[0]!.leafSlotId, last)
    yield* h.writer.ReconcileSummaryJobs({ userId: h.userId, running: [] })
    const claimed = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
    assert.strictEqual(claimed!.id, fixture.jobId)
    assert.strictEqual(claimed!.leafSlotId, last)
  })
)

for (const phase of ["missing leaf", "plan", "reconcile", "claim", "job"] as const) {
  const config = testConfig()
  it.live(
    `the pool completes queued work after ${phase}`,
    () => {
      let manual: Summarizer["Service"]
      let start: (reader: Reader["Service"], writer: Writer["Service"]) => Effect.Effect<void, unknown, Scope.Scope>
      const layer = Layer.effect(
        Summarizer,
        Effect.gen(function* () {
          const context = (yield* Effect.context<Providers | SummaryChecks | ChatHub | AppConfig>()).pipe(
            Context.pick(Providers, SummaryChecks, ChatHub, AppConfig)
          )
          start = (reader, writer) =>
            makeSummarizer(true).pipe(
              Effect.provide(context),
              Effect.provideService(Reader, reader),
              Effect.provideService(Writer, writer),
              Effect.asVoid
            )
          manual = yield* makeSummarizer(false)
          return manual
        })
      )
      return Effect.gen(function* () {
        const h = yield* lcmHarness({ config, summarizer: () => manual })
        const job = phase === "plan" ? undefined : yield* h.enqueue(0, h.rows.length - 1)
        if (phase === "missing leaf")
          yield* fixtureSql(h.dataDir, [
            { sql: "UPDATE summarization_jobs SET leaf_slot_id=NULL WHERE id=?", params: [job!.id] }
          ])
        const failed = yield* Deferred.make<void>()
        let injected = false
        const failOnce = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.suspend(() => {
            if (injected) return effect
            injected = true
            return Deferred.succeed(failed, undefined).pipe(
              Effect.andThen(Schema.decodeUnknownEffect(Schema.String)(null)),
              Effect.orDie,
              Effect.andThen(effect)
            )
          })
        yield* start(
          Reader.of({
            ...h.reader,
            PlanSummaries: (input, options) =>
              phase === "plan"
                ? failOnce(h.reader.PlanSummaries(input, options))
                : h.reader.PlanSummaries(input, options),
            AssembleSummary: (input, options) =>
              phase === "job"
                ? failOnce(h.reader.AssembleSummary(input, options))
                : h.reader.AssembleSummary(input, options)
          }),
          Writer.of({
            ...h.writer,
            ReconcileSummaryJobs: (input, options) =>
              phase === "reconcile"
                ? failOnce(h.writer.ReconcileSummaryJobs(input, options))
                : h.writer.ReconcileSummaryJobs(input, options),
            // Lose an acknowledgement after the claim committed, like a bad decoded
            // response. Reconciliation must refund it before claiming the job again.
            ClaimSummaryJob: (input, options) =>
              phase === "claim"
                ? h.writer
                    .ClaimSummaryJob(input, options)
                    .pipe(Effect.flatMap((result) => failOnce(Effect.succeed(result))))
                : h.writer.ClaimSummaryJob(input, options)
          })
        )
        if (phase !== "missing leaf") yield* Deferred.await(failed)
        // A bad plan must also leave the scheduler alive for work enqueued later.
        const queued = job ?? (yield* h.enqueue(0, h.rows.length - 1))
        let row: Record<string, unknown> | undefined
        for (let n = 0; n < 100; n++) {
          const [rows] = yield* fixtureSql(h.dataDir, [
            { sql: "SELECT status,attempts,claim_epoch FROM summarization_jobs WHERE id=?", params: [queued.id] }
          ])
          row = rows![0]
          if (row?.status === "complete") break
          yield* Effect.sleep(100)
        }
        assert.strictEqual(row?.status, "complete")
        assert.strictEqual(row!.attempts, phase === "job" ? 2 : 1)
        assert.strictEqual(row!.claim_epoch, phase === "job" || phase === "claim" ? 2 : 1)
      }).pipe(Effect.provide(serverLayer(config, undefined, layer)))
    },
    60_000
  )
}

it.live(
  "a held maintenance plan leaves the next send and the job claim loop running",
  () => {
    const config = testConfig()
    let manual: Summarizer["Service"]
    let start: (
      reader: Reader["Service"],
      writer: Writer["Service"]
    ) => Effect.Effect<Summarizer["Service"], unknown, Scope.Scope>
    const layer = Layer.effect(
      Summarizer,
      Effect.gen(function* () {
        const context = (yield* Effect.context<Providers | SummaryChecks | ChatHub | AppConfig>()).pipe(
          Context.pick(Providers, SummaryChecks, ChatHub, AppConfig)
        )
        start = (reader, writer) =>
          makeSummarizer(true).pipe(
            Effect.provide(context),
            Effect.provideService(Reader, reader),
            Effect.provideService(Writer, writer)
          )
        manual = yield* makeSummarizer(false)
        return manual
      })
    )
    return Effect.gen(function* () {
      const h = yield* lcmHarness({ config, summarizer: () => manual })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const claimed = yield* Deferred.make<string>()
      const pool = yield* start(
        Reader.of({
          ...h.reader,
          PlanSummaries: (input, options) =>
            input.reason === undefined
              ? h.reader.PlanSummaries(input, options)
              : Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(h.reader.PlanSummaries(input, options))
                )
        }),
        Writer.of({
          ...h.writer,
          ClaimSummaryJob: (input, options) =>
            h.writer
              .ClaimSummaryJob(input, options)
              .pipe(Effect.tap((job) => (job ? Deferred.succeed(claimed, job.id) : Effect.void)))
        })
      )
      const position = {
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.chat.currentForkId!,
        leafSlotId: h.rows.at(-1)!.slotId
      }
      yield* pool.afterReply(position)
      yield* Deferred.await(entered)
      yield* pool.beforeReply(position)
      const job = yield* h.enqueue(0, h.rows.length - 1)
      assert.strictEqual(yield* Deferred.await(claimed), job.id)
      assert.isFalse(yield* Deferred.isDone(release))
      yield* Deferred.succeed(release, undefined)
    }).pipe(Effect.provide(serverLayer(config, undefined, layer)))
  },
  30000
)
