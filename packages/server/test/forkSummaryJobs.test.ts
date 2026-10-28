import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion } from "@rp/shared/chat.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { completeFixture, fixtureSql, summaryJob } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"

for (const status of ["complete", "failed"] as const)
  lcmTest(`a sibling's ${status} summary cannot cover a divergent path with the same first slot`, (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, {
        messages: 2,
        settings: { recentTarget: 400, recentMax: 1400, leafInput: 400 }
      })
      if (status === "complete")
        yield* completeFixture(
          h.dataDir,
          h.writer,
          h.userId,
          h.chat.id,
          h.rows.map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
        )
      else {
        const job = yield* summaryJob(h.dataDir, h.chat.id, h.rows[0]!.slotId, h.rows[1]!.slotId)
        yield* fixtureSql(h.dataDir, [
          {
            sql: "UPDATE summarization_jobs SET attempts=1,max_retries=0 WHERE id=?",
            params: [job.jobId]
          }
        ])
        yield* h.writer.FailSummaryAttempt({
          userId: h.userId,
          jobId: job.jobId,
          attempt: 0,
          rolloutId: null,
          error: "Synthetic terminal failure."
        })
      }
      const fork = (yield* h.writer.CreateFork({
        userId: h.userId,
        chatId: h.chat.id,
        fromForkId: h.chat.currentForkId!,
        atSlotId: h.rows[0]!.slotId
      })).fork
      let leaf = h.rows[0]!.slotId
      for (let n = 0; n < 30; n++) {
        const row = yield* h.writer.AppendMessage({
          userId: h.userId,
          chatId: h.chat.id,
          forkId: fork.id,
          parentSlotId: leaf,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content: `Different branch ${n}. ` + "The river ran on. ".repeat(10),
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
        leaf = row.slotId
      }
      const plan = yield* h.reader.PlanSummaries({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: fork.id,
        leafSlotId: leaf,
        reason: "reply"
      })
      assert.strictEqual(plan.chunks[0]?.inputs[0]?.slotId, h.rows[0]!.slotId)
      assert.notInclude(
        plan.chunks.flatMap((c) => c.inputs.map((i) => i.slotId)),
        h.rows[1]!.slotId
      )
      const enqueued = yield* h.writer.EnqueueSummaries({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: fork.id,
        leafSlotId: leaf,
        requestClass: "interactive",
        chunks: plan.chunks
      })
      assert.lengthOf(enqueued, plan.chunks.length)
      assert.strictEqual(enqueued[0]?.firstSlotId, h.rows[0]!.slotId)
    })
  )

lcmTest("summary jobs assemble, complete and repair in their fork when another fork becomes current", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8, summarizer: () => ({ text: "A generated summary." }) })
    const main = h.chat.currentForkId!
    const summary = yield* completeFixture(
      h.dataDir,
      h.writer,
      h.userId,
      h.chat.id,
      h.rows.slice(0, 2).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
    )
    const g = (yield* h.writer.CreateFork({
      userId: h.userId,
      chatId: h.chat.id,
      fromForkId: main,
      atSlotId: h.rows.at(-1)!.slotId
    })).fork.id
    yield* h.api.EditSummary({
      summaryId: summary.id,
      forkId: main,
      content: "F continuity only.",
      expectedRowVersion: summary.rowVersion,
      commitDraft: null
    })
    yield* h.api.EditSummary({
      summaryId: summary.id,
      forkId: g,
      content: "G continuity only.",
      expectedRowVersion: summary.rowVersion,
      commitDraft: null
    })
    for (const forkId of [main, g]) {
      const own = forkId === main ? "F" : "G"
      yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, forkId, change: { tail: `${own} summary instruction.` } })
      const built = JSON.parse(
        (yield* h.reader.AssembleContext({
          userId: h.userId,
          chatId: h.chat.id,
          slotId: h.rows.at(-1)!.slotId,
          versionId: h.rows.at(-1)!.version.id,
          forkId,
          now: 1,
          timeZone: "UTC",
          frozen: null
        })).snapshot
      ) as ContextSnapshot
      assert.include(JSON.stringify(built.request), `${own} continuity only.`)
      assert.notInclude(JSON.stringify(built.request), `${own === "F" ? "G" : "F"} continuity only.`)
    }
    const inputs = h.rows.slice(2, 4).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
    const fJobs = yield* h.writer.EnqueueSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      forkId: main,
      leafSlotId: h.rows.at(-1)!.slotId,
      requestClass: "interactive",
      chunks: [{ inputs, target: 100 }]
    })
    const gJobs = yield* h.writer.EnqueueSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      forkId: g,
      leafSlotId: h.rows.at(-1)!.slotId,
      requestClass: "interactive",
      chunks: [{ inputs, target: 100 }]
    })
    assert.lengthOf(fJobs, 1)
    assert.lengthOf(gJobs, 1)
    for (const forkId of [main, g]) {
      const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.strictEqual(job!.forkId, forkId)
      const assembled = JSON.parse(
        (yield* h.reader.AssembleSummary({ userId: h.userId, jobId: job!.id, attempt: job!.epoch })).snapshot
      ) as ContextSnapshot
      const own = forkId === main ? "F" : "G"
      assert.include(JSON.stringify(assembled.request), `${own} summary instruction.`)
      assert.include(JSON.stringify(assembled.request), `${own} continuity only.`)
      yield* h.summarizer.runJob(job!)
    }
    const [rollouts] = yield* fixtureSql(
      h.dataDir,
      [
        {
          sql: "SELECT r.fork_id,j.fork_id AS job_fork FROM rollouts r JOIN summarization_jobs j ON j.rollout_id=r.id WHERE j.chat_id=? AND r.kind='summarize'",
          params: [h.chat.id]
        }
      ],
      { readOnly: true }
    )
    assert.lengthOf(rollouts!, 2)
    assert.isTrue(rollouts!.every((r) => r.fork_id === r.job_fork))
  })
)

lcmTest("a paused backfill holds only its own fork's jobs", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8, summarizer: () => ({ text: "Summary." }) })
    const main = h.chat.currentForkId!
    const g = (yield* h.writer.CreateFork({
      userId: h.userId,
      chatId: h.chat.id,
      fromForkId: main,
      atSlotId: h.rows.at(-1)!.slotId
    })).fork.id
    const payload = {
      chatId: h.chat.id,
      forkId: main,
      leafSlotId: h.rows.at(-1)!.slotId,
      choice: "scratch",
      startedAt: 1,
      armed: false,
      paused: true,
      capped: false,
      drive: false,
      approvedTokens: 10000000,
      approvedCost: null,
      currency: null,
      capTokens: 15000000,
      capCost: null
    }
    yield* fixtureSql(h.dataDir, [
      {
        sql: "INSERT INTO jobs(id,owner_user_id,kind,status,request_class,payload_json,created_at,updated_at) VALUES('fork-backfill',?,'lcm-backfill','processing','background',?,1,1)",
        params: [h.userId, JSON.stringify(payload)]
      }
    ])
    assert.strictEqual(
      (yield* h.reader.GetBackfill({ userId: h.userId, chatId: h.chat.id, forkId: main }))!.state,
      "paused"
    )
    assert.isNull(yield* h.reader.GetBackfill({ userId: h.userId, chatId: h.chat.id, forkId: g }))
    const inputs = h.rows.slice(0, 2).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
    for (const forkId of [main, g])
      yield* h.writer.EnqueueSummaries({
        userId: h.userId,
        chatId: h.chat.id,
        forkId,
        leafSlotId: h.rows.at(-1)!.slotId,
        requestClass: "interactive",
        chunks: [{ inputs, target: 100 }]
      })
    const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
    assert.strictEqual(job!.forkId, g)
    assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }))
    yield* h.writer.SetBackfill({ userId: h.userId, chatId: h.chat.id, forkId: main, action: "drive" })
    // Driving keeps a paused job paused; it cannot resume another fork's approval.
    assert.strictEqual(
      (yield* h.reader.GetBackfill({ userId: h.userId, chatId: h.chat.id, forkId: main }))!.state,
      "paused"
    )
  })
)
