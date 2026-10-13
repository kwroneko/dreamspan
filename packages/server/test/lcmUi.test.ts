// What the summary UI reads and writes (ARCHITECTURE §16), over a real server with summaries
// written by fixtures: the layer in use, coverage windows, revisions, rerun requests that
// never generate, the LCM switch, the draft behind an edit, and the event open chats get.
// Cross-user access is in the isolation matrix.
import { assert, it } from "@effect/vitest"
import { NewVersion } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import type { AppendResult } from "../src/db/ops.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { eventually } from "./support/generation.ts"
import { completeFixture, fixtureSql, summaryJob } from "./support/lcmFixtures.ts"

const config = testConfig()
const version = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })

it.live("the layer, coverage, revisions, reruns, the switch and the edit draft", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      user = yield* api.Whoami(),
      writer = yield* Writer
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    const slots: Array<AppendResult> = []
    let parent: AppendResult["slotId"] | null = null
    for (let n = 0; n < 6; n++) {
      const entry: AppendResult = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: parent,
        branch: false,
        version: version(`message ${n}`),
        commitDraft: null
      })
      slots.push(entry)
      parent = entry.slotId
    }
    const leaf = slots.at(-1)!.slotId
    const input = (n: number) => ({ slotId: slots[n]!.slotId, versionId: slots[n]!.version.id, amendCount: 0 })
    const state = () => api.GetLcmState({ chatId: chat.id, leafSlotId: leaf })

    // No summaries yet; new chats have LCM on.
    const empty = yield* state()
    assert.isTrue(empty.enabled)
    assert.deepStrictEqual(
      [empty.layer.length, empty.failed.length, empty.jobs.length, empty.cursorDepth],
      [0, 0, 0, -1]
    )

    const a = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [input(0), input(1)])
    const b = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [input(2), input(3)])
    const top = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [a, b])
    const layer = yield* state()
    // The level-2 summary stands in for both; the layer holds one.
    assert.deepStrictEqual(
      layer.layer.map((s) => [s.level, s.from, s.to, s.fresh, s.revisionCount, s.rerun]),
      [[2, 1, 4, true, 1, false]]
    )
    assert.deepStrictEqual(layer.layer[0]!.children, [a.id, b.id])
    assert.strictEqual(layer.cursorDepth, 3)
    assert.isString(layer.layer[0]!.content)

    // Coverage lists every level over the window, without text.
    const wide = yield* api.GetLcmCoverage({ chatId: chat.id, leafSlotId: leaf, fromDepth: 0, toDepth: 5 })
    assert.deepStrictEqual(
      wide.summaries.map((s) => [s.level, s.from, s.to]),
      [
        [1, 1, 2],
        [1, 3, 4],
        [2, 1, 4]
      ]
    )
    assert.isTrue(wide.summaries.every((s) => s.content === null))
    const narrow = yield* api.GetLcmCoverage({ chatId: chat.id, leafSlotId: leaf, fromDepth: 2, toDepth: 2 })
    assert.deepStrictEqual(
      narrow.summaries.map((s) => [s.level, s.from, s.to]),
      [
        [1, 3, 4],
        [2, 1, 4]
      ]
    )
    const outside = yield* api.GetLcmCoverage({ chatId: chat.id, leafSlotId: leaf, fromDepth: 4, toDepth: 5 })
    assert.deepStrictEqual(outside.summaries, [])

    // An edit of message 2 makes the L1 over it stale and the level above it.
    yield* writer.AmendVersion({
      userId: user.id,
      versionId: slots[2]!.version.id,
      content: "message 2, amended",
      expectedRowVersion: 1
    })
    const stale = yield* state()
    assert.isFalse(stale.layer[0]!.fresh)

    // Revisions: an edit adds one and selects it; any can be selected again.
    const draftKey = { summaryId: top.id }
    assert.isNull(yield* api.GetSummaryDraft(draftKey))
    const draft = yield* api.SaveSummaryDraft({
      ...draftKey,
      draftId: null,
      content: "my version",
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: top.revisionId
    })
    assert.strictEqual((yield* api.GetSummaryDraft(draftKey))?.content, "my version")
    assert.strictEqual((yield* api.SummaryDraftHistory({ ...draftKey, limit: 10 })).length, 1)
    const edited = yield* api.EditSummary({
      summaryId: top.id,
      content: "my version",
      expectedRowVersion: top.rowVersion,
      commitDraft: { draftId: draft.id, session: draft.session }
    })
    assert.strictEqual(edited.summary.origin, "user")
    assert.strictEqual((yield* api.GetSummaryDraft(draftKey))?.status, "committed")
    const revisions = yield* api.ListSummaryRevisions({ summaryId: top.id })
    assert.deepStrictEqual(
      revisions.map((r) => [r.number, r.origin, r.selected]),
      [
        [1, "generated", false],
        [2, "user", true]
      ]
    )
    yield* api.SelectSummaryRevision({
      summaryId: top.id,
      revisionId: revisions[0]!.id,
      expectedRowVersion: edited.summary.rowVersion
    })
    assert.strictEqual((yield* state()).layer[0]!.revisionNumber, 1)

    // A discarded edit keeps no text in the field.
    const second = yield* api.SaveSummaryDraft({
      ...draftKey,
      draftId: null,
      content: "thrown away",
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: top.revisionId
    })
    const restored = yield* api.RestoreSummaryDraft({
      ...draftKey,
      draftId: second.id,
      seq: 0,
      expectedRowVersion: second.rowVersion
    })
    assert.strictEqual(restored.content, "")
    const discarded = yield* api.DiscardSummaryDraft({
      ...draftKey,
      draftId: second.id,
      expectedRowVersion: restored.rowVersion
    })
    assert.strictEqual(discarded.status, "discarded")

    // A rerun is a request, and withdrawing it removes it. Nothing was queued or run.
    const jobsBefore = yield* fixtureSql(config.dataDir, [{ sql: "SELECT count(*) AS n FROM summarization_jobs" }])
    yield* api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Summary", summaryId: top.id }, requested: true })
    yield* api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Summary", summaryId: top.id }, requested: true })
    assert.isTrue((yield* state()).layer[0]!.rerun)
    yield* api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Summary", summaryId: top.id }, requested: false })
    assert.isFalse((yield* state()).layer[0]!.rerun)
    assert.deepStrictEqual(
      yield* fixtureSql(config.dataDir, [{ sql: "SELECT count(*) AS n FROM summarization_jobs" }]),
      jobsBefore
    )

    // Unfinished and failed work on the path, and a failed job's retry request.
    const pending = yield* summaryJob(config.dataDir, chat.id, slots[4]!.slotId, slots[5]!.slotId)
    yield* fixtureSql(config.dataDir, [
      { sql: "UPDATE summarization_jobs SET status='failed', error='refused' WHERE id=?", params: [pending.jobId] }
    ])
    const jobs = (yield* state()).jobs
    assert.deepStrictEqual(
      jobs.map((j) => [j.status, j.from, j.to, j.error, j.rerun]),
      [["failed", 5, 6, "refused", false]]
    )
    yield* api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Job", jobId: pending.jobId }, requested: true })
    assert.isTrue((yield* state()).jobs[0]!.rerun)
    // A job on another branch isn't on this path.
    const side = yield* writer.AppendMessage({
      userId: user.id,
      chatId: chat.id,
      parentSlotId: slots[3]!.slotId,
      branch: true,
      version: version("a side branch"),
      commitDraft: null
    })
    const other = yield* api.GetLcmState({ chatId: chat.id, leafSlotId: side.slotId })
    assert.deepStrictEqual(other.jobs, [])
    assert.strictEqual(
      yield* outcome(
        api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Job", jobId: "nope" }, requested: true }),
        () => "allowed"
      ),
      "NotFound"
    )

    // The table refuses a request naming something in another chat, and moving one.
    const elsewhere = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Elsewhere",
      participants: [],
      greeting: null
    })
    const crossed = yield* Effect.exit(
      fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO summary_reruns (id, chat_id, summary_id, requested_at) VALUES ('crossed', ?, ?, 1)",
          params: [elsewhere.id, top.id]
        }
      ])
    )
    assert.isTrue(crossed._tag === "Failure")
    yield* api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Summary", summaryId: top.id }, requested: true })
    const moved = yield* Effect.exit(
      fixtureSql(config.dataDir, [{ sql: "UPDATE summary_reruns SET chat_id = ?", params: [elsewhere.id] }])
    )
    assert.isTrue(moved._tag === "Failure")
    yield* api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Summary", summaryId: top.id }, requested: false })

    // The switch keeps the other settings, and hides the layer.
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO state_events (id, chat_id, slot_id, version_id, seq, key, scope, value_json, origin, created_at) VALUES ('tail', ?, NULL, NULL, 99, 'lcm.settings', NULL, ?, 'user', 1)",
        params: [chat.id, JSON.stringify({ enabled: true, tail: "Be brief.", leafTarget: 300 })]
      }
    ])
    yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
    const off = yield* state()
    assert.isFalse(off.enabled)
    assert.deepStrictEqual([off.layer.length, off.jobs.length], [0, 0])
    yield* api.SetLcmEnabled({ chatId: chat.id, enabled: true })
    const settings = yield* fixtureSql(config.dataDir, [
      {
        sql: "SELECT value_json FROM state_events WHERE chat_id=? AND key='lcm.settings' ORDER BY seq DESC LIMIT 1",
        params: [chat.id]
      }
    ])
    assert.deepStrictEqual(JSON.parse(settings[0]![0]!["value_json"] as string), {
      enabled: true,
      tail: "Be brief.",
      leafTarget: 300
    })
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
)

it.live("open chats are told when summaries change", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      user = yield* api.Whoami(),
      writer = yield* Writer
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    const entry = yield* writer.AppendMessage({
      userId: user.id,
      chatId: chat.id,
      parentSlotId: null,
      branch: false,
      version: version("only"),
      commitDraft: null
    })
    const summary = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [
      { slotId: entry.slotId, versionId: entry.version.id, amendCount: 0 }
    ])
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const seen = (tag: ChatEvent["_tag"]) => events.filter((e) => e._tag === tag).length
    assert.strictEqual(seen("Lcm"), 0)
    yield* api.SetSummaryRerun({ chatId: chat.id, target: { _tag: "Summary", summaryId: summary.id }, requested: true })
    yield* eventually(() => seen("Lcm") === 1)
    yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
    yield* eventually(() => seen("Lcm") === 2 && seen("State") === 1)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
)
