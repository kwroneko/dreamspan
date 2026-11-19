import { lcmServer } from "./support/lcmHarness.ts"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId, type VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import type { Summary } from "@dreamspan/shared/lcm.ts"
import { client, outcome, testConfig } from "./support/config.ts"
import { completeFixture, fixtureSql, summaryJob } from "./support/lcmFixtures.ts"
const config = testConfig()
const server = lcmServer(config)

const said = (content: string, writer: "human" | "model" = "model") =>
  new NewVersion({
    speakerEntityId: null,
    writer,
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

/** A chat of `m0` (the user's) and `m1` (a reply, with an unselected swipe "two"), and helpers. */
const setup = Effect.gen(function* () {
  const api = yield* client()
  const user = yield* api.Whoami()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = user.id as UserId
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "Forks",
    participants: [],
    greeting: null
  })
  const main = chat.currentForkId! as ForkId
  const append = (parent: SlotId | null, content: string, forkId: ForkId = main, branch = false) =>
    writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId,
      parentSlotId: parent,
      branch,
      version: said(content, parent === null ? "human" : "model"),
      commitDraft: null
    })
  const m0 = yield* append(null, "m0")
  const m1 = yield* append(m0.slotId, "one")
  const two = yield* writer.AddVersion({
    userId,
    slotId: m1.slotId,
    version: said("two"),
    select: false,
    commitDraft: null
  })
  /** The path's texts as `forkId` shows it. */
  const texts = (forkId: ForkId) =>
    Effect.map(reader.GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 100 }), (path) =>
      path.entries.map((e) => e.version.content)
    )
  /** What `forkId` shows at a slot, and the slot's row version there. */
  const shown = (slotId: SlotId, forkId: ForkId) =>
    Effect.map(reader.GetSlot({ userId, slotId, forkId }), ({ entry }) => ({
      content: entry.version.content,
      versionId: entry.version.id,
      rowVersion: entry.rowVersion,
      shownForkId: entry.shownForkId
    }))
  const select = (slotId: SlotId, forkId: ForkId, versionId: VersionId) =>
    Effect.gen(function* () {
      const before = yield* shown(slotId, forkId)
      return yield* writer.SelectVersion({ userId, slotId, versionId, forkId, expectedVersionId: before.versionId })
    })
  const fork = (from: ForkId, at: SlotId | null) =>
    Effect.map(writer.CreateFork({ userId, chatId: chat.id, fromForkId: from, atSlotId: at }), (made) => made.fork.id)
  const rows = (sql: string, ...params: Array<string | number | null>) =>
    Effect.map(fixtureSql(config.dataDir, [{ sql, params }], { readOnly: true }), ([result]) => result!)
  return {
    api,
    userId,
    writer,
    reader,
    chatId: chat.id as ChatId,
    main,
    append,
    m0,
    m1,
    one: m1.version.id as VersionId,
    two: two.id as VersionId,
    texts,
    shown,
    select,
    fork,
    rows
  }
})

const summarized = Effect.gen(function* () {
  const h = yield* setup
  const summary = yield* completeFixture(
    config.dataDir,
    h.writer,
    h.userId,
    h.chatId,
    [
      { slotId: h.m0.slotId, versionId: h.m0.version.id, amendCount: 0 },
      { slotId: h.m1.slotId, versionId: h.one, amendCount: 0 }
    ],
    [],
    " m0 one"
  )
  const read = (forkId: ForkId) => h.api.GetSummary({ summaryId: summary.id, forkId })
  const edit = (forkId: ForkId, content: string, expectedRowVersion?: number) =>
    Effect.gen(function* () {
      const before = yield* read(forkId)
      return (yield* h.api.EditSummary({
        summaryId: summary.id,
        forkId,
        content,
        expectedRowVersion: expectedRowVersion ?? before.rowVersion,
        commitDraft: null
      })).summary
    })
  return { ...h, summary, read, edit }
})

describe("summary fork overrides", () => {
  it.live("edits and revision selections stay in their fork; later and capped lineages inherit them", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const g = yield* h.fork(h.main, h.m1.slotId)
      const unchanged = yield* h.read(g)
      const edited = yield* h.edit(h.main, "F's own summary")
      assert.strictEqual((yield* h.read(g)).content, unchanged.content)
      assert.strictEqual((yield* h.read(g)).rowVersion, unchanged.rowVersion)
      const later = yield* h.fork(h.main, h.m1.slotId)
      assert.strictEqual((yield* h.read(later)).content, edited.content)
      const earlierPoint = yield* h.fork(h.main, h.m0.slotId)
      assert.strictEqual((yield* h.read(earlierPoint)).content, edited.content)
      yield* h.edit(h.main, "F again")
      assert.strictEqual((yield* h.read(later)).content, edited.content)
      yield* h.api.SelectSummaryRevision({
        summaryId: h.summary.id,
        forkId: g,
        revisionId: edited.revisionId,
        expectedRowVersion: unchanged.rowVersion
      })
      assert.strictEqual((yield* h.read(g)).content, edited.content)
      assert.strictEqual((yield* h.read(h.main)).content, "F again")
      assert.strictEqual(yield* outcome(h.edit(h.main, "stale", edited.rowVersion)), "StaleWrite")
      let capped = later
      for (let n = 0; n < 65; n++) capped = yield* h.fork(capped, h.m1.slotId)
      assert.strictEqual((yield* h.read(capped)).content, edited.content)
      assert.isTrue(
        (yield* h.api.ListSummaryRevisions({ summaryId: h.summary.id, forkId: g })).find(
          (r) => r.id === edited.revisionId
        )!.selected
      )
      const [base] = yield* h.rows("SELECT selected_revision_id FROM summaries WHERE id=?", h.summary.id)
      assert.strictEqual(base!.selected_revision_id, h.summary.revisionId)
    }).pipe(Effect.provide(server.layer))
  )

  it.live("coverage and freshness use the named fork even at the same shared tip", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const g = yield* h.fork(h.main, h.m1.slotId)
      yield* h.select(h.m1.slotId, h.main, h.two)
      assert.isFalse((yield* h.read(h.main)).fresh)
      assert.isTrue((yield* h.read(g)).fresh)
      for (const forkId of [h.main, g]) {
        const coverage = yield* h.api.GetLcmCoverage({
          chatId: h.chatId,
          forkId,
          leafSlotId: h.m1.slotId,
          fromDepth: 0,
          toDepth: 1
        })
        assert.strictEqual(coverage.summaries.find((s) => s.id === h.summary.id)!.fresh, forkId === g)
      }
      yield* h.edit(h.main, "Only F")
      const state = yield* h.api.GetLcmState({ chatId: h.chatId, forkId: g, leafSlotId: h.m1.slotId })
      assert.strictEqual(state.layer[0]!.content, h.summary.content)
    }).pipe(Effect.provide(server.layer))
  )

  it.live("requests, cancellation and consumption follow frozen lineage without deleting inherited requests", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const g = yield* h.fork(h.main, h.m1.slotId)
      const ask = (forkId: ForkId, requested: boolean) =>
        h.api.SetSummaryRerun({
          chatId: h.chatId,
          forkId,
          target: { _tag: "Summary", summaryId: h.summary.id },
          requested
        })
      const state = (forkId: ForkId) => h.api.GetLcmState({ chatId: h.chatId, forkId, leafSlotId: h.m1.slotId })
      yield* ask(h.main, true)
      const later = yield* h.fork(h.main, h.m1.slotId)
      assert.isFalse((yield* state(g)).layer[0]!.rerun)
      assert.isTrue((yield* state(later)).layer[0]!.rerun)
      yield* ask(h.main, false)
      assert.isTrue((yield* state(later)).layer[0]!.rerun)
      const [request] = yield* h.rows("SELECT id FROM summary_reruns WHERE summary_id=?", h.summary.id)
      yield* h.writer.EnqueueSummaries({
        userId: h.userId,
        chatId: h.chatId,
        forkId: later,
        leafSlotId: h.m1.slotId,
        requestClass: "interactive",
        chunks: [{ inputs: h.summary.inputs, target: 100, refresh: true, rerunIds: [request!.id as string] }]
      })
      assert.isFalse((yield* state(later)).layer[0]!.rerun)
      assert.lengthOf((yield* state(later)).jobs, 1)
      assert.lengthOf((yield* state(g)).jobs, 0)
      assert.lengthOf((yield* state(h.main)).jobs, 0)
      assert.lengthOf(yield* h.rows("SELECT id FROM summary_reruns WHERE summary_id=?", h.summary.id), 1)
    }).pipe(Effect.provide(server.layer))
  )

  it.live("jobs for the same range coexist and retain their fork across claims and restart", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const g = yield* h.fork(h.main, h.m1.slotId)
      yield* h.select(h.m1.slotId, h.main, h.two)
      const enqueue = (forkId: ForkId, inputs: Summary["inputs"]) =>
        h.writer.EnqueueSummaries({
          userId: h.userId,
          chatId: h.chatId,
          forkId,
          leafSlotId: h.m1.slotId,
          requestClass: "interactive",
          chunks: [{ inputs, target: 100, refresh: true }]
        })
      const fJobs = yield* enqueue(h.main, [
        h.summary.inputs[0]!,
        { slotId: h.m1.slotId, versionId: h.two, amendCount: 0 }
      ])
      const gJobs = yield* enqueue(g, h.summary.inputs)
      assert.lengthOf(fJobs, 1)
      assert.lengthOf(gJobs, 1)
      assert.strictEqual(fJobs[0]!.forkId, h.main)
      assert.strictEqual(gJobs[0]!.forkId, g)
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE summarization_jobs SET status='failed' WHERE chat_id<>? AND status='pending'",
          params: [h.chatId]
        }
      ])
      const claimed = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
      assert.strictEqual(claimed!.forkId, h.main)
      // A second fork's range is independent of the first fork's serial L1 ordering.
      assert.strictEqual((yield* h.writer.ClaimSummaryJob({ userId: h.userId }))!.forkId, g)
      const reset = yield* h.writer.ResetSummaryJobs()
      assert.includeMembers(
        reset.filter((r) => r.chatId === h.chatId).map((r) => r.forkId),
        [h.main, g]
      )
    }).pipe(Effect.provide(server.layer))
  )
  it.live("summaries_done preserves a coordinated replacement; ordinary replacements and later amends are stale", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const g = yield* h.fork(h.main, h.m1.slotId)
      const preview = yield* h.api.PreviewHistory({
        chatId: h.chatId,
        forkId: h.main,
        search: {
          pairs: [{ find: "m0", replace: "coordinated rename" }],
          matchCase: true,
          wholeWord: false,
          regex: false,
          preserveCase: false,
          messages: true,
          swipes: false,
          summaries: true
        }
      })
      const applied = yield* h.api.ApplyHistoryEdits({
        title: "Coordinated replacement",
        applications: [
          {
            chatId: h.chatId,
            forkId: h.main,
            summariesIncluded: false,
            edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      const copy = (yield* h.shown(h.m0.slotId, h.main)).versionId
      assert.isFalse((yield* h.read(h.main)).fresh)
      assert.isTrue((yield* h.read(g)).fresh)
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE fork_overrides SET summaries_done=1 WHERE changeset_id=?", params: [applied.changesetIds[0]!] },
        {
          sql: "UPDATE changeset_items SET after_json=json_set(after_json, '$.preservedInputs', json(?)) WHERE changeset_id=? AND target_kind='version_replace'",
          params: [JSON.stringify([{ id: h.m0.version.id, amends: 0 }]), applied.changesetIds[0]!]
        }
      ])
      assert.isTrue((yield* h.read(h.main)).fresh)
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE version_records SET content='amended afterwards' WHERE id=?", params: [copy] }
      ])
      assert.isFalse((yield* h.read(h.main)).fresh)
      assert.isTrue((yield* h.read(g)).fresh)
    }).pipe(Effect.provide(server.layer))
  )

  for (const edited of [false, true]) {
    it.live(
      edited
        ? "a fork's edited summary remains its own after history replacement"
        : "a coordinated history replacement leaves the sibling summary and freshness untouched",
      () =>
        Effect.gen(function* () {
          const h = yield* summarized
          const g = yield* h.fork(h.main, h.m1.slotId)
          const sibling = yield* h.read(g)
          if (edited) yield* h.edit(h.main, "m0 in F's own summary")
          const before = yield* h.read(h.main)
          const preview = yield* h.api.PreviewHistory({
            chatId: h.chatId,
            forkId: h.main,
            search: {
              pairs: [{ find: "m0", replace: "renamed" }],
              matchCase: true,
              wholeWord: false,
              regex: false,
              preserveCase: false,
              messages: true,
              swipes: true,
              summaries: true
            }
          })
          const summaryHit = preview.hits.find((hit) => hit.kind === "summary_revision")!
          assert.strictEqual(summaryHit.beforeId, before.revisionId)
          assert.strictEqual(summaryHit.before, before.content)
          yield* h.api.ApplyHistoryEdits({
            title: "Replace with summaries",
            applications: [
              {
                chatId: h.chatId,
                forkId: h.main,
                summariesIncluded: true,
                edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
                  kind,
                  targetId,
                  beforeId,
                  before,
                  after
                }))
              }
            ]
          })
          const replaced = yield* h.read(h.main)
          assert.strictEqual(replaced.content, summaryHit.after)
          assert.isTrue(replaced.fresh)
          assert.deepStrictEqual(yield* h.read(g), sibling)
          if (edited) assert.strictEqual(replaced.content, "renamed in F's own summary")
          const state = yield* h.api.GetLcmState({ chatId: h.chatId, forkId: h.main, leafSlotId: h.m1.slotId })
          assert.strictEqual(state.layer[0]!.revisionId, replaced.revisionId)
          const message = yield* h.reader.GetSlot({
            userId: h.userId,
            slotId: h.m0.slotId,
            forkId: h.main
          })
          yield* h.writer.AmendVersion({
            userId: h.userId,
            forkId: h.main,
            versionId: message.entry.version.id,
            expectedRowVersion: message.entry.version.rowVersion,
            content: "Amended after replacement"
          })
          assert.isFalse((yield* h.read(h.main)).fresh)
          assert.deepStrictEqual(yield* h.read(g), sibling)
        }).pipe(Effect.provide(server.layer))
    )
  }

  it.live("foreign forks are rejected on summary reads, edits, revisions and requests", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const other = yield* setup
      const forkId = other.main
      const params = { summaryId: h.summary.id, forkId }
      assert.strictEqual(yield* outcome(h.api.GetSummary(params)), "NotFound")
      assert.strictEqual(
        yield* outcome(h.api.EditSummary({ ...params, content: "wrong", expectedRowVersion: 1, commitDraft: null })),
        "NotFound"
      )
      assert.strictEqual(yield* outcome(h.api.ListSummaryRevisions(params)), "NotFound")
      assert.strictEqual(
        yield* outcome(
          h.api.SelectSummaryRevision({ ...params, revisionId: h.summary.revisionId, expectedRowVersion: 1 })
        ),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(
          h.api.SetSummaryRerun({
            chatId: h.chatId,
            forkId,
            target: { _tag: "Summary", summaryId: h.summary.id },
            requested: true
          })
        ),
        "NotFound"
      )
    }).pipe(Effect.provide(server.layer))
  )
  it.live("summary drafts remain in the fork where they were typed", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const g = yield* h.fork(h.main, h.m1.slotId)
      const saved = yield* h.api.SaveSummaryDraft({
        summaryId: h.summary.id,
        forkId: h.main,
        draftId: null,
        content: "F's unfinished text",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: h.summary.revisionId
      })
      assert.strictEqual(
        (yield* h.api.GetSummaryDraft({ summaryId: h.summary.id, forkId: h.main }))!.content,
        "F's unfinished text"
      )
      assert.isNull(yield* h.api.GetSummaryDraft({ summaryId: h.summary.id, forkId: g }))
      yield* h.api.SaveSummaryDraft({
        summaryId: h.summary.id,
        forkId: g,
        draftId: null,
        content: "G's unfinished text",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: h.summary.revisionId
      })
      const fDraft = yield* h.api.GetSummaryDraft({ summaryId: h.summary.id, forkId: h.main })
      assert.strictEqual(fDraft!.content, "F's unfinished text")
      assert.strictEqual(saved.id, fDraft!.id)
    }).pipe(Effect.provide(server.layer))
  )
  it.live("selecting a summary's own generated revision clears a redirect without pinning it over newer coverage", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      yield* h.api.SelectSummaryRevision({
        summaryId: h.summary.id,
        forkId: h.main,
        revisionId: h.summary.revisionId,
        expectedRowVersion: h.summary.rowVersion
      })
      const newer = yield* completeFixture(config.dataDir, h.writer, h.userId, h.chatId, h.summary.inputs)
      const state = yield* h.api.GetLcmState({ chatId: h.chatId, forkId: h.main, leafSlotId: h.m1.slotId })
      assert.strictEqual(state.layer[0]!.id, newer.id)
    }).pipe(Effect.provide(server.layer))
  )
  it.live("automatic refresh does not turn an identity choice into a preferred leaf above its condensation", () =>
    Effect.gen(function* () {
      const h = yield* summarized
      const a = yield* completeFixture(config.dataDir, h.writer, h.userId, h.chatId, [h.summary.inputs[0]!])
      const b = yield* completeFixture(config.dataDir, h.writer, h.userId, h.chatId, [h.summary.inputs[1]!])
      yield* h.api.SelectSummaryRevision({
        summaryId: b.id,
        forkId: h.main,
        revisionId: b.revisionId,
        expectedRowVersion: b.rowVersion
      })
      const job = yield* summaryJob(config.dataDir, h.chatId, b.firstSlotId, b.lastSlotId)
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE summarization_jobs SET source_summary_id=?,source_revision_id=? WHERE id=?",
          params: [b.id, b.revisionId, job.jobId]
        }
      ])
      const refreshed = yield* h.writer.CompleteSummary({
        userId: h.userId,
        ...job,
        content: "Refreshed B",
        status: "complete",
        inputs: b.inputs,
        children: []
      })
      const parent = yield* completeFixture(config.dataDir, h.writer, h.userId, h.chatId, [], [a, refreshed])
      const state = yield* h.api.GetLcmState({ chatId: h.chatId, forkId: h.main, leafSlotId: h.m1.slotId })
      assert.deepStrictEqual(
        state.layer.map((s) => s.id),
        [parent.id]
      )
    }).pipe(Effect.provide(server.layer))
  )
})
