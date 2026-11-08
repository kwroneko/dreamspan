import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { cardDoc } from "./support/docs.ts"

for (const layout of ["st", "concat", "swap_tail"] as const)
  for (const covered of [0, 1]) {
    it.effect(`seam preserves cut between overflows ${layout} covered=${covered}`, () =>
      Effect.gen(function* () {
        const base: AssemblyFixture = {
          cards: [{ entity: "mira", doc: cardDoc("Mira") }],
          participants: ["mira"],
          messages: [],
          summaries: covered
            ? [
                {
                  id: "summary-0",
                  chatId: "chat-1",
                  level: 1,
                  firstSlotId: "slot-0",
                  lastSlotId: "slot-0",
                  from: 1,
                  to: 1,
                  slotCount: 1,
                  revisionNumber: 1,
                  revisionId: "revision-0",
                  content: "Summary zero.",
                  tokens: 4,
                  origin: "generated",
                  status: "complete",
                  error: null,
                  batchId: null,
                  rowVersion: 1,
                  fresh: true,
                  inputs: [],
                  children: []
                } as never
              ]
            : [],
          preset: importStPreset(JSON.stringify({ openai_max_context: 1000, openai_max_tokens: 40 })).document!,
          events: [
            { depth: null, event: { scope: null, data: { key: "lcm.settings", value: { enabled: true } } } },
            ...(layout === "st"
              ? []
              : [{ depth: null, event: { scope: null, data: { key: "layout.cards" as const, value: layout } } }])
          ]
        }
        const messages = (n: number): AssemblyFixture["messages"] =>
          Array.from({ length: n }, (_, i) => ({
            side: i % 2 ? "assistant" : "user",
            content: `RAW ${i}: ${"x".repeat(150)}`
          }))
        let previous = yield* assembleFixture({ ...base, messages: messages(1) })
        const cuts: number[] = []
        for (let n = 2; n <= 30; n++) {
          const next = yield* assembleFixture({ ...base, messages: messages(n), historyStart: previous.historyStart! })
          if (next.historyStart!.depth !== previous.historyStart!.depth) cuts.push(n)
          else if (cuts.length) {
            const lastRaw = previous.request.messages.findLastIndex(
              (m) => typeof m.content === "string" && m.content.includes("RAW ")
            )
            const prefix = previous.request.messages.slice(0, lastRaw + 1)
            assert.deepEqual(
              next.request.messages.slice(0, prefix.length),
              prefix,
              "the whole sent prefix stays identical between cuts"
            )
          }
          if (cuts.length >= 2) {
            assert.isAbove(cuts[1]! - cuts[0]!, 1, "the retained suffix still has target-to-maximum runway")
            break
          }
          previous = next
        }
      })
    )
  }

lcmTest("more than four stale summaries finish after one reply", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 14, settings: { fanout: 10 } })
    for (let i = 0; i < 5; i++) {
      yield* h.enqueue(i * 2, i * 2 + 1)
      yield* h.drain
    }
    const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 100 })
    for (let i = 0; i < 5; i++) {
      const e = path.entries[i * 2]!
      yield* h.api.EditVersion({
        slotId: e.slotId,
        sourceVersionId: e.version.id,
        content: `Changed ${i}.`,
        expectedRowVersion: e.rowVersion
      })
    }
    const ran = yield* h.settle
    assert.lengthOf(ran, 5)
    const state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.isTrue(
      state.layer.every((s) => s.fresh),
      "one reply and completion cascade must finish all affected summaries"
    )
  })
)

lcmTest("hand edit after automatic refresh enqueue is retained", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8 })
    yield* h.enqueue(0, 1)
    yield* h.drain
    const old = (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!
    const e = h.rows[0]!
    yield* h.api.EditVersion({
      slotId: e.slotId,
      sourceVersionId: e.version.id,
      content: "Changed input.",
      expectedRowVersion: 1
    })
    assert.lengthOf(yield* h.plan("reply"), 1)
    yield* h.api.EditSummary({
      summaryId: old.id,
      content: "MY MANUAL SUMMARY",
      expectedRowVersion: old.rowVersion,
      commitDraft: null
    })
    yield* h.drain
    const state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.strictEqual(state.layer[0]!.content, "MY MANUAL SUMMARY")
    assert.isFalse(state.layer[0]!.fresh)
    assert.isTrue(state.layer[0]!.replacementAvailable)
    yield* h.api.SetSummaryRerun({ chatId: h.chat.id, target: { _tag: "Summary", summaryId: old.id }, requested: true })
    yield* h.plan("reply")
    yield* h.drain
    const revisions = yield* h.api.ListSummaryRevisions({ summaryId: old.id })
    assert.lengthOf(revisions, 4)
    const beforePick = yield* h.api.GetSummary({ summaryId: old.id })
    const chosen = yield* h.api.SelectSummaryRevision({
      summaryId: old.id,
      revisionId: revisions[2]!.id,
      expectedRowVersion: beforePick.rowVersion
    })
    const picked = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.strictEqual(picked.layer[0]!.id, chosen.id)
    assert.strictEqual(picked.layer[0]!.content, "A summary.")
    assert.deepEqual(
      (yield* h.api.ListSummaryRevisions({ summaryId: old.id })).filter((r) => r.selected).map((r) => r.id),
      [chosen.revisionId]
    )
    const manual = yield* h.api.GetSummary({ summaryId: old.id })
    yield* h.api.SelectSummaryRevision({
      summaryId: old.id,
      revisionId: manual.revisionId,
      expectedRowVersion: manual.rowVersion
    })
    assert.strictEqual(
      (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!.content,
      "MY MANUAL SUMMARY"
    )
  })
)

lcmTest("rerun with spendAhead disabled is answered", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8 })
    yield* h.enqueue(0, 1)
    yield* h.drain
    const old = (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!
    yield* h.defaults({ spendAhead: false })
    yield* h.api.SetSummaryRerun({ chatId: h.chat.id, target: { _tag: "Summary", summaryId: old.id }, requested: true })
    const planned = yield* h.reader.PlanSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      leafSlotId: h.rows.at(-1)!.slotId,
      reason: "reply"
    })
    const made = yield* h.plan("reply")
    assert.lengthOf(planned.refresh, 1)
    assert.lengthOf(made, 1)
  })
)

lcmTest("successful retry clears current failure display", (server) =>
  Effect.gen(function* () {
    let refuse = true
    const h = yield* lcmHarness(server, {
      messages: 8,
      summarizer: () => (refuse ? { refusal: true } : { text: "Accepted summary." })
    })
    yield* h.enqueue(0, 1)
    yield* h.drain
    let state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    yield* h.api.SetSummaryRerun({
      chatId: h.chat.id,
      target: { _tag: "Summary", summaryId: state.failed[0]!.id },
      requested: true
    })
    const failedId = state.failed[0]!.id
    refuse = false
    yield* h.plan("reply")
    yield* h.drain
    state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    const coverage = yield* h.api.GetLcmCoverage({
      chatId: h.chat.id,
      leafSlotId: h.rows.at(-1)!.slotId,
      fromDepth: 0,
      toDepth: 7
    })
    assert.lengthOf(
      coverage.summaries.filter((s) => s.status === "failed"),
      0
    )
    const history = yield* h.api.GetLcmCoverage({
      chatId: h.chat.id,
      leafSlotId: h.rows.at(-1)!.slotId,
      fromDepth: 0,
      toDepth: 7,
      includeResolved: true
    })
    assert.isTrue(history.summaries.find((s) => s.id === failedId)!.resolved)
    assert.lengthOf(state.jobs, 0)
    assert.lengthOf(state.failed, 0, "historical failure must not be shown as current failure after successful retry")
  })
)

lcmTest("a completion must not start re-summarizing an edit made after the last reply", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8, settings: { fanout: 2 } })
    for (let i = 0; i < 2; i++) {
      yield* h.enqueue(i * 2, i * 2 + 1)
      yield* h.drain
    }
    yield* h.plan("completion")
    yield* h.drain
    const state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    const top = yield* h.api.GetSummary({ summaryId: state.layer[0]!.id })
    const child = yield* h.api.GetSummary({ summaryId: top.children[0]!.summaryId })
    yield* h.enqueue(4, 5) // unrelated work already queued before the edit
    yield* h.api.EditSummary({
      summaryId: child.id,
      content: "User changed the child after the last reply.",
      expectedRowVersion: child.rowVersion,
      commitDraft: null
    })
    yield* h.drain // that work finishes; its completion is the next planning trigger
    const jobs = yield* h.plan("completion")
    assert.lengthOf(
      jobs,
      0,
      "completion from unrelated work must wait for the next reply before refreshing newly stale parents"
    )
  })
)

lcmTest("hand-written condensation stays selected after covered edit", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8, settings: { fanout: 2 } })
    for (let i = 0; i < 2; i++) {
      yield* h.enqueue(i * 2, i * 2 + 1)
      yield* h.drain
    }
    yield* h.plan("completion")
    yield* h.drain
    const before = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    const top = before.layer[0]!
    yield* h.api.EditSummary({
      summaryId: top.id,
      content: "MY HAND-WRITTEN CONDENSATION",
      expectedRowVersion: top.rowVersion,
      commitDraft: null
    })
    const e = h.rows[0]!
    yield* h.api.EditVersion({
      slotId: e.slotId,
      sourceVersionId: e.version.id,
      content: "Changed covered input.",
      expectedRowVersion: 1
    })
    const after = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.isTrue(
      after.layer.some((s) => s.id === top.id),
      "manual condensation should remain selected and flagged"
    )
  })
)

lcmTest("rerunning a condensed child updates the context", (server) =>
  Effect.gen(function* () {
    let n = 0
    const h = yield* lcmHarness(server, {
      messages: 8,
      settings: { fanout: 2 },
      summarizer: () => ({ text: `Summary ${++n}.` })
    })
    for (let i = 0; i < 2; i++) {
      yield* h.enqueue(i * 2, i * 2 + 1)
      yield* h.drain
    }
    yield* h.plan("completion")
    yield* h.drain
    const before = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    const top = yield* h.api.GetSummary({ summaryId: before.layer[0]!.id })
    yield* h.defaults({ spendAhead: false })
    yield* h.api.SetSummaryRerun({
      chatId: h.chat.id,
      target: { _tag: "Summary", summaryId: top.children[0]!.summaryId },
      requested: true
    })
    yield* h.settle
    const after = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.notStrictEqual(after.layer[0]!.id, top.id, "rerun child should propagate to the selected condensation")
  })
)

lcmTest("a frozen reply episode survives restart and leaves later edits for the next reply", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 16, settings: { fanout: 10 } })
    for (let i = 0; i < 6; i++) {
      yield* h.enqueue(i * 2, i * 2 + 1)
      yield* h.drain
    }
    const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 100 })
    for (let i = 0; i < 5; i++) {
      const e = path.entries[i * 2]!
      yield* h.api.EditVersion({
        slotId: e.slotId,
        sourceVersionId: e.version.id,
        content: `Authorized ${i}.`,
        expectedRowVersion: e.rowVersion
      })
    }
    assert.lengthOf(yield* h.plan("reply"), 4)
    const later = path.entries[10]!
    yield* h.api.EditVersion({
      slotId: later.slotId,
      sourceVersionId: later.version.id,
      content: "Edited after the reply.",
      expectedRowVersion: later.rowVersion
    })
    yield* h.writer.ResetSummaryJobs()
    yield* h.drain
    assert.lengthOf(yield* h.plan("completion"), 1)
    yield* h.drain
    assert.lengthOf(yield* h.plan("completion"), 0)
    let state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.deepEqual(
      state.layer.filter((s) => !s.fresh).map((s) => s.from),
      [11]
    )
    yield* h.settle
    state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.isTrue(state.layer.every((s) => s.fresh))
  })
)

lcmTest("a failed summary retry is admitted with spending ahead off", (server) =>
  Effect.gen(function* () {
    let refused = true
    const h = yield* lcmHarness(server, {
      messages: 8,
      summarizer: () => (refused ? { refusal: true } : { text: "Recovered." })
    })
    yield* h.enqueue(0, 1)
    yield* h.drain
    yield* h.defaults({ spendAhead: false })
    const failed = (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).failed[0]!
    yield* h.api.SetSummaryRerun({
      chatId: h.chat.id,
      target: { _tag: "Summary", summaryId: failed.id },
      requested: true
    })
    refused = false
    assert.lengthOf(yield* h.plan("reply"), 1)
    assert.lengthOf(yield* h.drain, 1)
    assert.strictEqual(
      (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!.content,
      "Recovered."
    )
  })
)

lcmTest("a stale enqueue rolls back and can be planned again", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 180 })
    const position = { userId: h.userId, chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId }
    const before = yield* h.reader.PlanSummaries(position)
    const row = h.rows[0]!
    yield* h.api.EditVersion({
      slotId: row.slotId,
      sourceVersionId: row.version.id,
      content: "Changed between plan and enqueue.",
      expectedRowVersion: 1
    })
    const failed = yield* h.writer
      .EnqueueSummaries({ ...position, chunks: before.chunks, requestClass: "background" })
      .pipe(Effect.result)
    assert.strictEqual(failed._tag, "Failure")
    const next = yield* h.reader.PlanSummaries(position)
    assert.isNotEmpty(
      yield* h.writer.EnqueueSummaries({ ...position, chunks: next.chunks, requestClass: "background" })
    )
    const [rows] = yield* fixtureSql(h.dataDir, [
      { sql: "SELECT count(*) AS n FROM summarization_jobs WHERE chat_id=?", params: [h.chat.id] }
    ])
    assert.strictEqual(rows![0]!.n, next.chunks.length)
  })
)

lcmTest("a long legacy manual leaf reruns in bounded parts without repeating paid work", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 650,
      message: (n) => `Message ${n}. ` + "The road ran on. ".repeat(7),
      settings: { fanout: 10 }
    })
    const old = yield* completeFixture(
      h.dataDir,
      h.writer,
      h.userId,
      h.chat.id,
      h.rows.slice(0, 640).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
    )
    yield* h.api.EditSummary({
      summaryId: old.id,
      content: "A legacy hand-written summary.",
      expectedRowVersion: old.rowVersion,
      commitDraft: null
    })
    yield* h.defaults({ spendAhead: false })
    yield* h.api.SetSummaryRerun({ chatId: h.chat.id, target: { _tag: "Summary", summaryId: old.id }, requested: true })
    const ran = yield* h.settle
    assert.lengthOf(ran, 5, "the same reply finishes all five capped parts exactly once")
    assert.strictEqual(
      (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!.content,
      "A legacy hand-written summary."
    )
    assert.lengthOf(yield* h.plan("completion"), 0)
  })
)

lcmTest("a parent refresh cannot bypass a manually protected child", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8, settings: { fanout: 2 } })
    for (let i = 0; i < 2; i++) {
      yield* h.enqueue(i * 2, i * 2 + 1)
      yield* h.drain
    }
    yield* h.plan("completion")
    yield* h.drain
    const top = (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!
    const parent = yield* h.api.GetSummary({ summaryId: top.id })
    const child = yield* h.api.GetSummary({ summaryId: parent.children[0]!.summaryId })
    yield* h.api.EditVersion({
      slotId: h.rows[0]!.slotId,
      sourceVersionId: h.rows[0]!.version.id,
      content: "Changed material.",
      expectedRowVersion: 1
    })
    yield* h.plan("reply")
    yield* h.api.EditSummary({
      summaryId: child.id,
      content: "My protected child.",
      expectedRowVersion: child.rowVersion,
      commitDraft: null
    })
    yield* h.drain
    yield* h.settle
    const state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.isTrue(state.layer.some((s) => s.id === child.id && s.content === "My protected child."))
    const plan = yield* h.reader.PlanSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      leafSlotId: h.rows.at(-1)!.slotId,
      reason: "reply"
    })
    assert.isTrue(plan.flagged.includes(parent.id))
    assert.lengthOf(plan.condensations, 0)
  })
)

lcmTest("a failed explicit redo remains current until a later successful retry", (server) =>
  Effect.gen(function* () {
    let refuse = false
    const h = yield* lcmHarness(server, {
      messages: 8,
      summarizer: () => (refuse ? { refusal: true } : { text: "A accepted summary." })
    })
    yield* h.enqueue(0, 1)
    yield* h.drain
    const old = (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!
    refuse = true
    yield* h.api.SetSummaryRerun({ chatId: h.chat.id, target: { _tag: "Summary", summaryId: old.id }, requested: true })
    yield* h.plan("reply")
    yield* h.drain
    let state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.lengthOf(state.failed, 1, "older successful coverage does not resolve a later failure")
    assert.strictEqual(state.layer[0]!.id, old.id)
    refuse = false
    yield* h.api.SetSummaryRerun({
      chatId: h.chat.id,
      target: { _tag: "Summary", summaryId: state.failed[0]!.id },
      requested: true
    })
    yield* h.plan("reply")
    yield* h.drain
    state = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    assert.lengthOf(state.failed, 0)
  })
)

lcmTest("an explicit request admits its already queued automatic refresh with spending ahead off", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8 })
    yield* h.enqueue(0, 1)
    yield* h.drain
    const old = (yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!
    yield* h.api.EditVersion({
      slotId: h.rows[0]!.slotId,
      sourceVersionId: h.rows[0]!.version.id,
      content: "Changed input.",
      expectedRowVersion: 1
    })
    const queued = yield* h.plan("reply")
    assert.lengthOf(queued, 1)
    yield* h.defaults({ spendAhead: false })
    yield* h.api.SetSummaryRerun({ chatId: h.chat.id, target: { _tag: "Summary", summaryId: old.id }, requested: true })
    const answered = yield* h.plan("reply")
    assert.isTrue(answered.some((j) => j.id === queued[0]!.id))
    assert.lengthOf(yield* h.drain, 1)
    assert.isFalse((yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })).layer[0]!.rerun)
  })
)
