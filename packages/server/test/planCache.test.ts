// What a reader keeps of a fork's summary facts between plans (db/lcmFactStore.ts): each write
// kind either moves the chat's LCM stamp or leaves facts that are still true, and a plan from
// kept facts equals one read afresh.
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion, type ForkId, type SlotId } from "@rp/shared/chat.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

const text = (content: string, writer: "human" | "model" = "human") =>
  new NewVersion({
    speakerEntityId: null,
    writer,
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

lcmTest(
  "kept summary facts match a fresh read after every kind of write",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 12 })
      const main = h.chat.currentForkId!
      let leaf = h.rows.at(-1)!.slotId as SlotId
      const inputs = h.rows.slice(0, 8).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      const left = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(0, 4))
      const right = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, inputs.slice(4))
      const top = yield* completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, [], [left, right])
      const at = (forkId: ForkId, slot: SlotId) => ({ userId: h.userId, chatId: h.chat.id, forkId, leafSlotId: slot })
      const plans = (forkId: ForkId = main, slot = leaf) =>
        Effect.all([
          h.reader.PlanSummaries(at(forkId, slot)),
          h.reader.PlanSummaries({ ...at(forkId, slot), reason: "reply" })
        ])
      const stamp = Effect.map(
        fixtureSql(h.dataDir, [{ sql: "SELECT lcm_stamp AS stamp FROM chats WHERE id=?", params: [h.chat.id] }], {
          readOnly: true
        }),
        (rows) => rows[0]![0]!.stamp as number
      )
      // Moving the stamp by hand makes every reader read its facts again: the fresh reference.
      const forget = fixtureSql(h.dataDir, [
        { sql: "UPDATE chats SET lcm_stamp=lcm_stamp+1 WHERE id=?", params: [h.chat.id] }
      ])
      const step = <A, E, R>(name: string, moves: boolean, write: Effect.Effect<A, E, R>, forkId: ForkId = main) =>
        Effect.gen(function* () {
          yield* plans(forkId)
          const before = yield* stamp
          const result = yield* write
          assert.strictEqual((yield* stamp) !== before, moves, `${name}: whether the stamp moved`)
          const kept = yield* plans(forkId)
          yield* forget
          assert.deepStrictEqual(kept, yield* plans(forkId), `${name}: kept facts plan as fresh ones`)
          return result
        })
      // This branch-local override was added by the thinking replay work. The generic
      // semantic-override trigger must fence it even after both planning readers are warm.
      for (const hidden of [true, false])
        yield* step(
          `thinking sections ${hidden ? "hidden" : "shown"}`,
          true,
          h.writer.SetThinkingHidden({
            userId: h.userId,
            versionId: h.rows[0]!.version.id,
            forkId: main,
            part: "sections",
            hidden
          })
        )
      // Appending: no summary's input changes, and the kept leaf's facts extend to the new one.
      const user = yield* step(
        "append",
        false,
        h.writer.AppendMessage({
          userId: h.userId,
          chatId: h.chat.id,
          parentSlotId: leaf,
          branch: false,
          commitDraft: null,
          version: text("A synthetic turn after the summarized stretch.")
        })
      )
      leaf = user.slotId
      // A message no summary has as an input: written, swiped, edited, all without moving it.
      const recent = h.rows.at(-1)!
      yield* step(
        "swipe a recent message",
        false,
        h.writer.AddVersion({
          userId: h.userId,
          slotId: recent.slotId,
          forkId: main,
          select: true,
          commitDraft: null,
          version: text("A recent alternative.", recent.version.writer === "model" ? "model" : "human")
        })
      )
      // Each change to a summarized message moves it.
      const source = h.rows[1]!
      const swipe = yield* step(
        "swipe an input",
        true,
        h.writer.AddVersion({
          userId: h.userId,
          slotId: source.slotId,
          forkId: main,
          select: true,
          commitDraft: null,
          version: text("A different synthetic choice.", source.version.writer === "model" ? "model" : "human")
        })
      )
      const shown = yield* h.reader.GetSlot({ userId: h.userId, slotId: source.slotId, forkId: main })
      yield* step(
        "amend an input",
        true,
        h.writer.AmendVersion({
          userId: h.userId,
          versionId: swipe.id,
          forkId: main,
          content: "Amended synthetic choice.",
          expectedRowVersion: shown.entry.version.rowVersion
        })
      )
      yield* step(
        "select an input's version",
        true,
        h.writer.SelectVersion({
          userId: h.userId,
          slotId: source.slotId,
          forkId: main,
          versionId: source.version.id,
          expectedVersionId: (yield* h.reader.GetSlot({ userId: h.userId, slotId: source.slotId, forkId: main })).entry
            .version.id
        })
      )
      yield* step(
        "hide an input",
        true,
        h.writer.SetSlotHidden({ userId: h.userId, slotId: h.rows[2]!.slotId, forkId: main, hidden: true })
      )
      yield* step(
        "show it again",
        true,
        h.writer.SetSlotHidden({ userId: h.userId, slotId: h.rows[2]!.slotId, forkId: main, hidden: false })
      )
      const binned = yield* step(
        "delete an input",
        true,
        h.writer.DeleteMessage({ userId: h.userId, slotId: h.rows[5]!.slotId, forkId: main })
      )
      yield* step("restore it", true, h.writer.RestoreBinItem({ userId: h.userId, itemId: binned.id }))
      // A new fork is a new view: its facts are its own, and the parent's stay kept.
      const made = yield* h.writer.CreateFork({
        userId: h.userId,
        chatId: h.chat.id,
        fromForkId: main,
        atSlotId: h.rows[9]!.slotId
      })
      const tab = made.fork.id
      const [mainPlans, tabPlans] = yield* Effect.all([plans(main), plans(tab, h.rows[9]!.slotId as SlotId)], {
        concurrency: 2
      })
      yield* step(
        "swipe an input in the other tab",
        true,
        h.writer.AddVersion({
          userId: h.userId,
          slotId: source.slotId,
          forkId: tab,
          select: true,
          commitDraft: null,
          version: text("The other tab choice.", source.version.writer === "model" ? "model" : "human")
        }),
        tab
      )
      assert.deepStrictEqual(yield* plans(main), mainPlans, "an action on one branch leaves the other's plan")
      assert.notDeepEqual(yield* plans(tab, h.rows[9]!.slotId as SlotId), tabPlans)
      // Summaries: a rewrite, choosing a revision, a rerun request; a new summary is found by its rowid.
      const draft = yield* h.api.SaveSummaryDraft({
        summaryId: left.id,
        draftId: null,
        content: "A user rewrite.",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: left.revisionId
      })
      const rewritten = yield* step(
        "rewrite a summary",
        true,
        h.api.EditSummary({
          forkId: main,
          summaryId: left.id,
          content: "A user rewrite.",
          expectedRowVersion: left.rowVersion,
          commitDraft: { draftId: draft.id, session: draft.session }
        })
      )
      yield* step(
        "select a summary's first revision",
        true,
        h.api.SelectSummaryRevision({
          forkId: main,
          summaryId: left.id,
          revisionId: left.revisionId,
          expectedRowVersion: rewritten.summary.rowVersion
        })
      )
      yield* step(
        "ask for a rerun",
        // A per-fork rerun row (an override that no message has) moves it, as every such kind does.
        true,
        h.api.SetSummaryRerun({
          chatId: h.chat.id,
          forkId: main,
          target: { _tag: "Summary", summaryId: top.id },
          requested: true
        })
      )
      const later = h.rows.slice(8, 12).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      yield* step("complete a summary", false, completeFixture(h.dataDir, h.writer, h.userId, h.chat.id, later))
      // Settings are read on every plan.
      yield* step(
        "change the chunk settings",
        false,
        h.writer.ChangeLcmSettings({
          userId: h.userId,
          chatId: h.chat.id,
          forkId: main,
          change: { recentTarget: 6_000, recentMax: 10_000 }
        })
      )
      // A plan in flight: jobs are read live, never kept.
      const pending = (yield* plans())[1]
      const chunks = [...pending.refresh, ...pending.chunks]
      assert.isAbove(chunks.length, 0, "the stale summaries ask for jobs")
      yield* step(
        "queue summary jobs",
        false,
        h.writer.EnqueueSummaries({ ...at(main, leaf), chunks, requestClass: "background" })
      )
      yield* step("claim one", false, h.writer.ClaimSummaryJob({ userId: h.userId }))
      // A restarted reader keeps nothing: the kept facts were only ever a copy.
      assert.lengthOf(h.mock.requests(), 0)
    }),
  { timeout: 120_000 }
)

lcmTest(
  "staged adoption publishes a lower-rowid summary after readers have kept a newer one",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 12 })
      const at = {
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.chat.currentForkId!,
        leafSlotId: h.rows.at(-1)!.slotId
      }
      const params = {
        ...at,
        choice: "adopt" as const,
        approved: { jobs: 0, tokens: 0, cost: 0, currency: "USD" },
        imported: {
          noteEntity: "synthetic-staged-note",
          content: "Synthetic imported summary.",
          firstSlotId: h.rows[0]!.slotId,
          lastSlotId: h.rows[7]!.slotId,
          slotCount: 8,
          hidden: 0
        }
      }
      let stage = yield* h.writer.StageLcmEnable(params)
      while (!stage.ready) stage = yield* h.writer.StageLcmEnable({ ...params, runId: stage.runId })
      yield* completeFixture(
        h.dataDir,
        h.writer,
        h.userId,
        h.chat.id,
        h.rows.slice(8).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      )
      const inspect = Effect.map(
        fixtureSql(
          h.dataDir,
          [
            {
              sql: "SELECT lcm_stamp AS stamp,(SELECT rowid FROM summaries WHERE id=?) AS staged,(SELECT max(rowid) FROM summaries WHERE chat_id=?) AS top FROM chats WHERE id=?",
              params: [stage.runId, h.chat.id, h.chat.id]
            }
          ],
          { readOnly: true }
        ),
        (rows) => rows[0]![0]!
      )
      const plans = Effect.all([h.reader.PlanSummaries(at), h.reader.PlanSummaries({ ...at, reason: "reply" })])
      const before = yield* plans
      const old = yield* inspect
      assert.isBelow(old.staged as number, old.top as number)
      yield* h.writer.EnableLcm({
        ...at,
        choice: "adopt",
        approved: params.approved,
        runId: stage.runId,
        switchOff: []
      })
      assert.isAbove((yield* inspect).stamp as number, old.stamp as number, "publication fences the late seal")
      const kept = yield* plans
      assert.notStrictEqual(kept[1].maintenancePins, before[1].maintenancePins)
      yield* fixtureSql(h.dataDir, [{ sql: "UPDATE chats SET lcm_stamp=lcm_stamp+1 WHERE id=?", params: [h.chat.id] }])
      assert.deepStrictEqual(kept, yield* plans)
      assert.lengthOf(h.mock.requests(), 0)
    }),
  { timeout: 120_000 }
)

lcmTest(
  "a new tail after deleting the kept leaf plans identically from kept and fresh facts",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 12 })
      const at = {
        userId: h.userId,
        chatId: h.chat.id,
        forkId: h.chat.currentForkId!,
        leafSlotId: h.rows.at(-1)!.slotId
      }
      yield* completeFixture(
        h.dataDir,
        h.writer,
        h.userId,
        h.chat.id,
        h.rows.slice(0, 8).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      )
      yield* h.reader.PlanSummaries(at)
      yield* h.reader.PlanSummaries({ ...at, reason: "reply" })
      yield* h.writer.DeleteMessage({ userId: h.userId, slotId: at.leafSlotId, forkId: at.forkId })
      const made = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId: h.chat.id,
        parentSlotId: h.rows[10]!.slotId,
        branch: false,
        commitDraft: null,
        version: text("Synthetic replacement tail.")
      })
      const position = { ...at, leafSlotId: made.slotId }
      const plans = Effect.all([
        h.reader.PlanSummaries(position),
        h.reader.PlanSummaries({ ...position, reason: "reply" })
      ])
      const kept = yield* plans
      yield* fixtureSql(h.dataDir, [{ sql: "UPDATE chats SET lcm_stamp=lcm_stamp+1 WHERE id=?", params: [h.chat.id] }])
      assert.deepStrictEqual(kept, yield* plans)
      assert.lengthOf(h.mock.requests(), 0)
    }),
  { timeout: 120_000 }
)
