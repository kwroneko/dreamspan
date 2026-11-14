import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion, type ForkId } from "@rp/shared/chat.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

lcmTest(
  "planning facts expire at every transaction and stay independent in tabs forked at every depth",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 12 })
      const main = h.chat.currentForkId!
      const position = { userId: h.userId, chatId: h.chat.id, forkId: main, leafSlotId: h.rows.at(-1)!.slotId }
      const inputs = h.rows.slice(0, 8).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      const left = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(0, 4))
      const right = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(4))
      yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, [], [left, right])
      const plan = (forkId: ForkId = main) => h.reader.PlanSummaries({ ...position, forkId, reason: "reply" })
      const clean = yield* plan()
      assert.lengthOf(clean.refresh, 0)
      const forks: Array<ForkId> = []
      for (const row of h.rows) {
        const made = yield* h.writer.CreateFork({
          userId: h.userId,
          chatId: h.chat.id,
          fromForkId: main,
          atSlotId: row.slotId
        })
        forks.push(made.fork.id)
        const p = yield* h.reader.PlanSummaries({
          ...position,
          forkId: made.fork.id,
          leafSlotId: row.slotId,
          reason: "reply"
        })
        assert.lengthOf(p.refresh, 0)
      }
      // Two tabs on paths with identical endpoints and different effective inputs.
      const tab = forks.at(-1)!
      const source = h.rows[1]!
      const swipe = yield* h.writer.AddVersion({
        userId: h.userId,
        slotId: source.slotId,
        forkId: tab,
        select: true,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "A different synthetic choice.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const [a, b] = yield* Effect.all([plan(), plan(tab)], { concurrency: 2 })
      assert.deepStrictEqual(a, clean)
      assert.deepStrictEqual(
        b.refresh.map((r) => r.sourceSummaryId),
        [left.id]
      )
      assert.strictEqual(b.refresh[0]!.inputs[1]!.versionId, swipe.id)
      const shown = yield* h.reader.GetSlot({ userId: h.userId, slotId: source.slotId, forkId: tab })
      yield* h.writer.AmendVersion({
        userId: h.userId,
        versionId: swipe.id,
        forkId: tab,
        content: "Amended synthetic choice.",
        expectedRowVersion: shown.entry.version.rowVersion
      })
      const amended = yield* plan(tab)
      assert.notDeepEqual(amended.maintenancePins, b.maintenancePins)
      assert.strictEqual(amended.refresh[0]!.inputs[1]!.amendCount, 1)
      const deleted = yield* h.writer.DeleteMessage({ userId: h.userId, slotId: source.slotId, forkId: tab })
      assert.isNull((yield* plan(tab)).refresh[0]!.inputs[1]!.versionId)
      yield* h.writer.RestoreBinItem({ userId: h.userId, itemId: deleted.id })
      const restored = (yield* h.reader.GetSlot({ userId: h.userId, slotId: source.slotId, forkId: tab })).entry.version
      assert.strictEqual(restored.content, "Amended synthetic choice.")
      assert.strictEqual((yield* plan(tab)).refresh[0]!.inputs[1]!.versionId, restored.id)
      yield* h.writer.SelectVersion({
        userId: h.userId,
        slotId: source.slotId,
        forkId: tab,
        versionId: source.version.id,
        expectedVersionId: restored.id
      })
      assert.lengthOf((yield* plan(tab)).refresh, 0)
      assert.deepStrictEqual(yield* plan(), clean)
      // A summary job in flight cannot turn a previous plan into an admission decision.
      const edited = yield* h.writer.AmendVersion({
        userId: h.userId,
        versionId: h.rows[5]!.version.id,
        forkId: tab,
        content: "A changed second range.",
        expectedRowVersion: 1
      })
      const stale = yield* plan(tab)
      assert.deepStrictEqual(
        stale.refresh.map((r) => r.sourceSummaryId),
        [right.id]
      )
      const jobs = yield* h.writer.EnqueueSummaries({
        ...position,
        forkId: tab,
        chunks: stale.refresh,
        requestClass: "background"
      })
      assert.lengthOf(jobs, 1)
      yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.lengthOf((yield* plan(tab)).refresh, 0)
      assert.deepStrictEqual(yield* plan(), clean)
      assert.isString(edited.id)
      // Settings are always read again, including account defaults and model availability.
      yield* h.writer.ChangeLcmSettings({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: main,
        change: { enabled: false }
      })
      assert.isFalse((yield* plan()).enabled)
      yield* h.writer.ChangeLcmSettings({
        userId: h.userId,
        chatId: h.chat.id,
        forkId: main,
        change: { enabled: true }
      })
      assert.deepStrictEqual(yield* plan(), clean)
      // A summary rewrite and selecting its original revision refresh the ancestor proof.
      const draft = yield* h.api.SaveSummaryDraft({
        summaryId: left.id,
        draftId: null,
        content: "A user rewrite.",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: left.revisionId
      })
      const rewritten = yield* h.api.EditSummary({
        forkId: main,
        summaryId: left.id,
        content: "A user rewrite.",
        expectedRowVersion: left.rowVersion,
        commitDraft: { draftId: draft.id, session: draft.session }
      })
      assert.notDeepEqual((yield* plan()).maintenancePins, clean.maintenancePins)
      yield* h.api.SelectSummaryRevision({
        forkId: main,
        summaryId: left.id,
        revisionId: left.revisionId,
        expectedRowVersion: rewritten.summary.rowVersion
      })
      assert.deepStrictEqual((yield* plan()).refresh, clean.refresh)
      // Rolled-back summary writes cannot leave a cache entry ahead of durable state.
      const before = yield* plan()
      const rollback = yield* Effect.exit(
        fixtureSql(h.dataDir, [
          {
            sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES('rolled-back',?,'never committed',1,'user',1)",
            params: [left.id]
          },
          { sql: "SELECT * FROM deliberately_missing_table" }
        ])
      )
      assert.strictEqual(rollback._tag, "Failure")
      assert.deepStrictEqual(yield* plan(), before)
      // Race a second connection's committed edit with a cached plan; the following read
      // must use the committed input even when the summary was already stale beforehand.
      for (let n = 0; n < 20; n++) {
        const current = (yield* h.reader.GetSlot({ userId: h.userId, slotId: h.rows[0]!.slotId, forkId: main })).entry
          .version
        const [changed] = yield* Effect.all(
          [
            h.writer.AmendVersion({
              userId: h.userId,
              forkId: main,
              versionId: current.id,
              content: `Concurrent synthetic edit ${n}.`,
              expectedRowVersion: current.rowVersion
            }),
            plan()
          ],
          { concurrency: 2 }
        )
        const next = yield* plan()
        assert.strictEqual(next.refresh.find((r) => r.sourceSummaryId === left.id)!.inputs[0]!.versionId, changed.id)
      }
      assert.lengthOf(h.mock.requests(), 0)
      // Removing an immutability guard disables both caches, including already checked lineage.
      const latest = (yield* h.reader.GetSlot({ userId: h.userId, slotId: h.rows[0]!.slotId, forkId: main })).entry
        .version
      yield* fixtureSql(h.dataDir, [
        { sql: "DROP TRIGGER summary_inputs_immutable" },
        {
          sql: "UPDATE summary_inputs SET version_id=?,amend_count=? WHERE summary_id=? AND ordinal=0",
          params: [latest.id, latest.rowVersion - 1, left.id]
        }
      ])
      assert.lengthOf((yield* plan()).refresh, 0)
      const binned = yield* h.writer.DeleteChat({ userId: h.userId, chatId: h.chat.id })
      assert.strictEqual((yield* Effect.exit(plan()))._tag, "Failure", "a deleted chat cannot reuse cached facts")
      yield* h.writer.PurgeBinItem({ userId: h.userId, itemId: binned.id })
      assert.strictEqual((yield* Effect.exit(plan()))._tag, "Failure", "purged summaries cannot reuse cached facts")
    }),
  { timeout: 120000 }
)

lcmTest("retains ending-slot and insertion order in the complete maintenance pins", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 8 })
    const inputs = h.rows.map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
    // Create out of path order, then put a parent at the same endpoint as its last child.
    const right = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(4, 6))
    const left = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(0, 2))
    const middle = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(2, 4))
    const parent = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, [], [left, middle])
    const plan = yield* h.reader.PlanSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      leafSlotId: h.rows.at(-1)!.slotId,
      reason: "reply"
    })
    const pins = JSON.parse(plan.maintenancePins!) as { signatures: Record<string, string> }
    assert.deepStrictEqual(Object.keys(pins.signatures), [left.id, middle.id, parent.id, right.id])
    assert.lengthOf(h.mock.requests(), 0)
  })
)
