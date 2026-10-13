import { assert } from "@effect/vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { eventually } from "./support/generation.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { lastText, lcmHarness, lcmTest, requestsTo } from "./support/lcmHarness.ts"

type Harness = Effect.Success<ReturnType<typeof lcmHarness>>

const rowsOf = (h: Harness) =>
  fixtureSql(h.dataDir, [
    {
      sql: `SELECT s.id,s.level,s.status,s.error_json,s.first_slot_id,s.last_slot_id,r.content,r.origin
        FROM summaries s JOIN summary_revisions r ON r.id=s.selected_revision_id WHERE s.chat_id=? ORDER BY s.created_at,s.id`,
      params: [h.chat.id]
    }
  ]).pipe(Effect.map(([rows]) => rows!))
const contextOf = (h: Harness) =>
  Effect.gen(function* () {
    const leaf = h.rows.at(-1)!
    const assembled = yield* h.reader.AssembleContext({
      userId: h.userId,
      chatId: h.chat.id,
      slotId: leaf.slotId,
      versionId: leaf.version.id,
      now: 1,
      timeZone: "UTC",
      frozen: null
    })
    return JSON.parse(assembled.snapshot) as ContextSnapshot
  })
const jobsOf = (h: Harness) =>
  fixtureSql(h.dataDir, [
    {
      sql: `SELECT id,level,status,eager,absorbed_parent_id,input_child_ids FROM summarization_jobs WHERE chat_id=? ORDER BY created_at,id`,
      params: [h.chat.id]
    }
  ]).pipe(Effect.map(([rows]) => rows!))
/** The replies are numbered, so a test can tell which request a summary came from. */
const numbered = () => {
  let n = 0
  return () => ({ text: `Summary ${++n}.` })
}
/** Level-1 summaries over pairs of messages: 0-1, 2-3, ... */
const pairs = (h: Harness, count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < count; i++) {
      yield* h.enqueue(i * 2, i * 2 + 1)
      yield* h.drain
    }
  })

lcmTest("a fanout of level-1 summaries condenses into one of the next level through the summarizer", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 12, settings: { fanout: 3 }, summarizer: numbered() })
    yield* pairs(h, 3)
    assert.lengthOf(requestsTo(h.mock, "primary-model"), 3)
    // A finished job continues the cascade: nothing else is stale, and the three are a run.
    const made = yield* h.plan("completion")
    assert.lengthOf(made, 1)
    assert.strictEqual(made[0]!.level, 2)
    const [job] = yield* jobsOf(h).pipe(Effect.map((rows) => rows.filter((r) => r.level === 2)))
    const l1 = (yield* rowsOf(h)).filter((r) => r.level === 1)
    assert.deepStrictEqual(
      JSON.parse(job!.input_child_ids as string),
      l1.map((r) => r.id)
    )
    yield* h.drain
    const rows = yield* rowsOf(h)
    assert.deepStrictEqual(
      rows.map((r) => r.level),
      [1, 1, 1, 2]
    )
    const top = rows[3]!
    assert.strictEqual(top.status, "complete")
    assert.strictEqual(top.content, "Summary 4.")
    // The request was the summary layer cut after the parts, with no history, and a tail naming them.
    const request = requestsTo(h.mock, "primary-model").at(-1)!
    const texts = JSON.stringify(request.body!.messages)
    for (const part of ["Summary 1.", "Summary 2.", "Summary 3."]) assert.include(texts, part)
    assert.include(lastText(request), "Condense the last 3 summaries above (messages 1 to 6)")
    assert.notInclude(texts, "Message 8.", "no history follows the parts")
    const [ledger] = yield* fixtureSql(h.dataDir, [
      { sql: "SELECT count(*) AS n FROM llm_requests WHERE chat_id=? AND purpose='condense'", params: [h.chat.id] }
    ])
    assert.strictEqual(Number(ledger![0]!.n), 1)
    // The parts are pinned, and the next context sends the condensation instead of them.
    const [lineage] = yield* fixtureSql(h.dataDir, [
      { sql: "SELECT count(*) AS n FROM summary_parents WHERE summary_id=?", params: [top.id as string] }
    ])
    assert.strictEqual(Number(lineage![0]!.n), 3)
    const snapshot = yield* contextOf(h)
    assert.deepStrictEqual(
      snapshot.lcm!.selected.map((s) => [s.level, s.stale]),
      [[2, false]]
    )
    // Nothing is left to plan: the cascade is quiet.
    assert.lengthOf(yield* h.plan("reply"), 0)
  })
)

lcmTest("a refused condensation ends as a failed row, keeps its parts selected, and is not planned again", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 12,
      settings: { fanout: 3 },
      summarizer: (r) => (lastText(r).includes("Condense") ? { refusal: true } : { text: "A part." })
    })
    yield* pairs(h, 3)
    yield* h.plan("completion")
    yield* h.drain
    const rows = yield* rowsOf(h)
    const failed = rows.find((r) => r.level === 2)!
    assert.strictEqual(failed.status, "failed")
    assert.deepInclude(JSON.parse(failed.error_json as string), { class: "refused", kind: "hard" })
    const [parts] = yield* fixtureSql(h.dataDir, [
      { sql: "SELECT count(*) AS n FROM summary_parents WHERE summary_id=?", params: [failed.id as string] }
    ])
    assert.strictEqual(Number(parts![0]!.n), 3, "a failed condensation records its parts")
    const snapshot = yield* contextOf(h)
    assert.deepStrictEqual(
      snapshot.lcm!.selected.map((s) => s.level),
      [1, 1, 1]
    )
    const before = requestsTo(h.mock, "primary-model").length
    assert.lengthOf(yield* h.plan("completion"), 0, "the failure holds its range while the parts are unchanged")
    assert.lengthOf(yield* h.plan("reply"), 0)
    assert.strictEqual(requestsTo(h.mock, "primary-model").length, before)
  })
)

lcmTest("over its budget the layer absorbs a run into the generated parent beside it", (server) =>
  Effect.gen(function* () {
    const big = (text: string) => text + " " + "word ".repeat(640)
    let n = 0
    const h = yield* lcmHarness(server, {
      messages: 16,
      settings: { fanout: 3, condenseTarget: 100, leafTarget: 1000 },
      summarizer: () => ({ text: big(`Summary ${++n}.`) })
    })
    // Five level-1 summaries; the last three are made into a parent by hand, so the first two are a run before it.
    yield* pairs(h, 5)
    const rows = yield* rowsOf(h)
    const l1 = rows.filter((r) => r.level === 1)
    const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 100 })
    assert.lengthOf(l1, 5)
    const made = yield* h.writer.EnqueueCondensations({
      userId: h.userId,
      chatId: h.chat.id,
      leafSlotId: path.entries.at(-1)!.slotId,
      requestClass: "interactive",
      jobs: [{ level: 2, children: l1.slice(2).map((r) => r.id as Summary["id"]), target: 1000, eager: false }]
    })
    assert.lengthOf(made, 1)
    yield* h.drain
    // The layer now holds the first two summaries, then the level-2 parent; about 2000 tokens of it, over the 25% maximum.
    const before = yield* contextOf(h)
    assert.deepStrictEqual(
      before.lcm!.selected.map((s) => s.level),
      [1, 1, 2]
    )
    const planned = yield* h.plan("completion")
    assert.lengthOf(planned, 1)
    const [job] = (yield* jobsOf(h)).filter((j) => j.eager === 1)
    assert.strictEqual(job!.level, 2)
    assert.isNotNull(job!.absorbed_parent_id)
    assert.deepStrictEqual(
      JSON.parse(job!.input_child_ids as string),
      l1.map((r) => r.id),
      "the run, then the parent's own parts"
    )
    yield* h.drain
    const after = yield* rowsOf(h)
    const statuses = Object.fromEntries(after.map((r) => [r.id, r.status]))
    assert.strictEqual(statuses[job!.absorbed_parent_id as string], "superseded")
    for (const r of l1.slice(0, 2))
      assert.strictEqual(statuses[r.id as string], "superseded", "the absorbed run leaves the pool")
    for (const r of l1.slice(2))
      assert.strictEqual(statuses[r.id as string], "complete", "the parent's own parts are kept as they were")
    const snapshot = yield* contextOf(h)
    assert.deepStrictEqual(
      snapshot.lcm!.selected.map((s) => s.level),
      [2]
    )
  })
)

lcmTest("editing under summaries starts nothing; the next reply writes each stale one again once", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 12, settings: { fanout: 3 }, summarizer: numbered() })
    yield* pairs(h, 3)
    yield* h.plan("completion")
    yield* h.drain
    const calls = () => requestsTo(h.mock, "primary-model").length
    assert.strictEqual(calls(), 4)
    assert.deepStrictEqual(
      (yield* contextOf(h)).lcm!.selected.map((s) => [s.level, s.stale]),
      [[2, false]]
    )
    // Many edits and swipes inside the middle summary's messages (2 and 3), and one inside the last (4).
    for (let i = 0; i < 4; i++) {
      const current = (yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 100 }))
        .entries
      const slot = current[2 + (i % 2)]!
      yield* h.api.EditVersion({
        slotId: slot.slotId,
        sourceVersionId: slot.version.id,
        content: `Edited ${i}. The road bent.`,
        expectedRowVersion: slot.rowVersion
      })
    }
    const afterEdits = (yield* contextOf(h)).lcm!.selected
    assert.deepStrictEqual(
      afterEdits.map((s) => [s.level, s.stale]),
      [
        [1, false],
        [1, true],
        [1, false]
      ],
      "a stale condensation is bypassed by its fresh parts; the stale part is the one still sent"
    )
    // Editing alone never starts a generation: no job, no request.
    assert.strictEqual((yield* jobsOf(h)).length, 4)
    assert.strictEqual(calls(), 4)
    // The next reply: one level-1 summary written again, then (its job finished) the condensation once.
    const first = yield* h.plan("reply")
    assert.deepStrictEqual(
      first.map((j) => j.level),
      [1]
    )
    assert.lengthOf(yield* h.plan("reply"), 0, "a second pass while the job is live plans nothing more")
    yield* h.drain
    const second = yield* h.plan("completion")
    assert.deepStrictEqual(
      second.map((j) => j.level),
      [2]
    )
    yield* h.drain
    assert.strictEqual(calls(), 6, "one request per affected summary")
    assert.lengthOf(yield* h.plan("reply"), 0)
    assert.lengthOf(yield* h.plan("completion"), 0)
    assert.strictEqual(calls(), 6)
    assert.deepStrictEqual(
      (yield* contextOf(h)).lcm!.selected.map((s) => [s.level, s.stale]),
      [[2, false]]
    )
    // The stale rows are kept: nothing was lost, and the old condensation is still there.
    assert.lengthOf(yield* rowsOf(h), 6)
  })
)

lcmTest("a summary the user wrote is flagged when stale and never replaced automatically", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8, settings: { fanout: 3 }, summarizer: numbered() })
    yield* pairs(h, 2)
    const [mine] = yield* rowsOf(h)
    const summary = yield* h.api.GetSummary({ summaryId: mine!.id as never })
    yield* h.api.EditSummary({
      summaryId: summary.id,
      content: "My own summary.",
      expectedRowVersion: summary.rowVersion,
      commitDraft: null
    })
    const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 100 })
    yield* h.api.EditVersion({
      slotId: path.entries[0]!.slotId,
      sourceVersionId: path.entries[0]!.version.id,
      content: "Changed under it.",
      expectedRowVersion: path.entries[0]!.rowVersion
    })
    const plan = yield* h.reader.PlanSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      leafSlotId: h.rows.at(-1)!.slotId as SlotId,
      reason: "reply"
    })
    assert.deepStrictEqual(plan.flagged, [mine!.id as never])
    assert.lengthOf(plan.refresh, 0)
    assert.lengthOf(yield* h.plan("reply"), 0)
    const snapshot = yield* contextOf(h)
    assert.strictEqual(
      snapshot.pieces.find((p) => p.source.kind === "summary" && p.source.id === mine!.id)?.text,
      "My own summary.",
      "the user's text stays in the context, marked stale"
    )
    assert.isTrue(snapshot.lcm!.selected[0]!.stale)
  })
)

lcmTest(
  "with the pool running, an edit starts nothing and the reply after it writes the stale summaries again once each",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 12, settings: { fanout: 3 }, summarizer: numbered() })
      const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 100 })
      const inputs = (from: number, to: number) =>
        path.entries
          .slice(from, to + 1)
          .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: e.version.rowVersion - 1 }))
      const parts: Array<Summary> = []
      for (const [from, to] of [
        [0, 1],
        [2, 3],
        [4, 5]
      ] as const)
        parts.push(yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs(from, to)))
      yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, [], parts)
      const summarizing = () =>
        requestsTo(h.mock, "primary-model").filter((r) => /Return only the summary/.test(lastText(r))).length
      const slot = path.entries[2]!
      yield* h.api.EditVersion({
        slotId: slot.slotId,
        sourceVersionId: slot.version.id,
        content: "Changed under the middle summary.",
        expectedRowVersion: slot.rowVersion
      })
      yield* Effect.sleep(900)
      assert.strictEqual(summarizing(), 0, "an edit never starts a generation")
      assert.lengthOf(yield* jobsOf(h), 4, "no job was made by the edit")
      // The next reply: its path uses the stale summary, so the pool writes it again, then the condensation.
      const sent = yield* h.api.Generate({ chatId: h.chat.id, parentSlotId: h.rows.at(-1)!.slotId, branch: false })
      assert.strictEqual(sent._tag, "Posted")
      yield* eventually(() => summarizing() >= 2, 30_000)
      yield* Effect.sleep(1200)
      assert.strictEqual(summarizing(), 2, "one request per affected summary")
      // The first four jobs are the fixtures that built the summaries.
      const done = (yield* jobsOf(h)).slice(4).filter((j) => j.status === "complete")
      assert.deepStrictEqual(
        done.map((j) => j.level),
        [1, 2]
      )
    }),
  { pool: true, timeout: 90_000 }
)
