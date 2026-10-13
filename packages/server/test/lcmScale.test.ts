import { assert } from "@effect/vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"

const MESSAGES = 100_000
/** What one write may take, however long the chat is: it holds the writer for every other write in the app. */
const WRITE_BOUND_MS = 300

lcmTest(
  "a 100,000-message chat's first plan enqueues a bounded batch in a short write and continues later",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0 })
      // The chat's history, written straight into the tables: one big chain of short human messages.
      const last = MESSAGES - 1
      const count = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${last})`
      yield* fixtureSql(h.dataDir, [
        {
          sql: `${count} INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
            SELECT 'big-v-' || i, 'big-s-' || i, 0, 'complete', 'human', 'The road ran on, mile ' || i || '.', 'verbatim', 'user_written', 1, 1 FROM n`
        },
        {
          sql: `${count} INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at)
            SELECT 'big-s-' || i, ?, (SELECT id FROM lanes WHERE chat_id = ?), CASE WHEN i = 0 THEN NULL ELSE 'big-s-' || (i - 1) END, i, 'big-v-' || i, 1 FROM n`,
          params: [h.chat.id, h.chat.id]
        },
        { sql: "UPDATE chats SET active_leaf_slot_id = ? WHERE id = ?", params: [`big-s-${last}`, h.chat.id] }
      ])
      const position = { userId: h.userId, chatId: h.chat.id, leafSlotId: `big-s-${last}` as SlotId }
      const plan = yield* h.reader.PlanSummaries(position)
      assert.isNull(plan.blocked)
      assert.isAbove(plan.chunks.length, 0)
      assert.isAtMost(plan.chunks.length, 4, "a plan asks for a bounded batch, not the whole backfill")
      const started = performance.now()
      const jobs = yield* h.writer.EnqueueSummaries({ ...position, chunks: plan.chunks, requestClass: "background" })
      const took = performance.now() - started
      assert.lengthOf(jobs, plan.chunks.length)
      assert.isBelow(took, WRITE_BOUND_MS, `the enqueue write took ${Math.round(took)} ms`)
      // The rest follows once these have run: planning again while they are live adds nothing.
      const again = yield* h.reader.PlanSummaries(position)
      assert.lengthOf(again.chunks, 0)
    }),
  { timeout: 240_000 }
)

lcmTest("with no model to summarize with, nothing is planned and the plan says why", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 40 })
    const sets = { model: null, preset: h.preset.ref.id, judge: null }
    yield* h.api.SetGenerationDefaults({ defaults: sets })
    const position = { userId: h.userId, chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId }
    const plan = yield* h.reader.PlanSummaries({ ...position, reason: "reply" })
    assert.strictEqual(plan.blocked, "no_model")
    assert.isTrue(plan.enabled)
    assert.lengthOf(plan.chunks, 0)
    assert.lengthOf(yield* h.summarizer.planNow(position), 0)
    const [jobs] = yield* fixtureSql(h.dataDir, [
      { sql: "SELECT count(*) AS n FROM summarization_jobs WHERE chat_id = ?", params: [h.chat.id] }
    ])
    assert.strictEqual(Number(jobs![0]!.n), 0, "no job was made to fail")
    // Choosing a model again unblocks it.
    yield* h.defaults()
    assert.isNull((yield* h.reader.PlanSummaries(position)).blocked)
  })
)
