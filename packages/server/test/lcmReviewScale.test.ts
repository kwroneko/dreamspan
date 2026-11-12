import { assert } from "@effect/vitest"
import { MAX_CHUNK_SLOTS } from "../src/db/lcmLimits.ts"
import { Effect } from "effect"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { fixtureSql, completeFixture } from "./support/lcmFixtures.ts"

lcmTest(
  "condensation enqueue scaling",
  (server) =>
    Effect.gen(function* () {
      for (const count of [1000, 100000]) {
        const h = yield* lcmHarness(server, { messages: 0 })
        const seq = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ${count - 1})`
        yield* fixtureSql(h.dataDir, [
          {
            sql: `${seq} INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at, authoring_fork_id) SELECT 'v-${count}-'||i,'s-${count}-'||i,0,'complete','human','synthetic','verbatim','user_written',1,1 , '${h.chat.currentForkId!}' FROM n`
          },
          {
            sql: `${seq} INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,created_at) SELECT 's-${count}-'||i,?,CASE WHEN i=0 THEN NULL ELSE 's-${count}-'||(i-1) END,i,'v-${count}-'||i,1 FROM n`,
            params: [h.chat.id]
          },
          { sql: "UPDATE chats SET active_leaf_slot_id=? WHERE id=?", params: [`s-${count}-${count - 1}`, h.chat.id] }
        ])
        const children = []
        for (const n of [count - 3, count - 2])
          children.push(
            yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, [
              { slotId: `s-${count}-${n}` as never, versionId: `v-${count}-${n}` as never, amendCount: 0 }
            ])
          )
        const before = performance.now()
        const jobs = yield* h.writer.EnqueueCondensations({
          userId: h.userId,
          chatId: h.chat.id,
          leafSlotId: `s-${count}-${count - 1}` as never,
          requestClass: "background",
          jobs: [{ level: 2, children: children.map((c) => c.id), target: 100, eager: false }]
        })
        const elapsed = performance.now() - before
        assert.isBelow(elapsed, 300, "the bounded enqueue holds the writer briefly")
        assert.lengthOf(jobs, 1)
      }
    }),
  { timeout: 240000 }
)

for (const absent of ["hidden", "deleted", "empty"] as const)
  lcmTest(
    `${absent} prefix does not create an unbounded chunk`,
    (server) =>
      Effect.gen(function* () {
        const h = yield* lcmHarness(server, { messages: 0 })
        const count = 100000
        const seq = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ${count - 1})`
        yield* fixtureSql(h.dataDir, [
          {
            sql: `${seq} INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at, authoring_fork_id) SELECT 'hidden-v-'||i,'hidden-s-'||i,0,'complete','human',?,'verbatim','user_written',1,1 , '${h.chat.currentForkId!}' FROM n`,
            params: ["story ".repeat(70)]
          },
          {
            sql: `${seq} INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,context_excluded,created_at) SELECT 'hidden-s-'||i,?,CASE WHEN i=0 THEN NULL ELSE 'hidden-s-'||(i-1) END,i,'hidden-v-'||i,CASE WHEN i<99900 THEN 1 ELSE 0 END,1 FROM n`,
            params: [h.chat.id]
          },
          { sql: "UPDATE chats SET active_leaf_slot_id='hidden-s-99999' WHERE id=?", params: [h.chat.id] },
          // Marks as the code before forks wrote them, which the database freezes now.
          { sql: "DROP TRIGGER slots_hide_frozen" },
          { sql: "DROP TRIGGER slots_deletion_per_fork" },
          ...(absent === "deleted"
            ? [
                {
                  sql: "UPDATE slots SET context_excluded=0,deleted_at=1 WHERE chat_id=? AND depth<99900",
                  params: [h.chat.id]
                }
              ]
            : absent === "empty"
              ? [
                  { sql: "UPDATE slots SET context_excluded=0 WHERE chat_id=?", params: [h.chat.id] },
                  {
                    sql: "UPDATE version_records SET content='' WHERE slot_id IN (SELECT id FROM slots WHERE chat_id=? AND depth<99900)",
                    params: [h.chat.id]
                  }
                ]
              : [])
        ])
        const position = { userId: h.userId, chatId: h.chat.id, leafSlotId: "hidden-s-99999" as never }
        const p = yield* h.reader.PlanSummaries(position)
        assert.isTrue(p.chunks.every((c) => c.inputs.length <= MAX_CHUNK_SLOTS))
        assert.lengthOf(p.chunks, 4)
        const started = performance.now()
        const outcome = yield* h.writer
          .EnqueueSummaries({ ...position, chunks: p.chunks, requestClass: "background" })
          .pipe(Effect.result)
        assert.isBelow(performance.now() - started, 300, "zero-content chunks keep the writer bounded")
        assert.strictEqual(outcome._tag, "Success")
        if (outcome._tag === "Success")
          assert.isTrue(
            outcome.success.every((j) => j.status === "complete"),
            "zero-content lineage needs no provider call"
          )
        assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }))
        const next = yield* h.reader.PlanSummaries(position)
        assert.strictEqual(next.chunks[0]!.inputs[0]!.slotId, `hidden-s-${4 * MAX_CHUNK_SLOTS}`)
        const metadata = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: position.leafSlotId })
        assert.strictEqual(metadata.cursorDepth, 4 * MAX_CHUNK_SLOTS - 1)
        assert.isTrue(metadata.layer.every((s) => s.fresh && s.tokens === 0))
        // A restored effective slot invalidates its empty coverage and comes back as raw text.
        yield* fixtureSql(h.dataDir, [
          { sql: "UPDATE slots SET context_excluded=0,deleted_at=NULL WHERE id='hidden-s-0'" },
          { sql: "UPDATE version_records SET content='Restored visible input.' WHERE id='hidden-v-0'" }
        ])
        const restored = yield* h.api.GetLcmState({ chatId: h.chat.id, leafSlotId: position.leafSlotId })
        assert.strictEqual(restored.cursorDepth, -1)
        assert.lengthOf(restored.layer, 0)
      }),
    { timeout: 240000 }
  )
