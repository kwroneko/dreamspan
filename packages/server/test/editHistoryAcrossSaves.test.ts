// A message's or a summary's edit history outlives its saves (owner, 2026-11-02): the library
// field's rule, with its retention. Saving or cancelling keeps every state; a reopened editor
// lists those from before the last save, and picking one makes it the newest state.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture } from "./support/lcmFixtures.ts"

const LONG = "A long passage typed with care, before an accidental select-all. ".repeat(10)

it.live("a message edit keeps its states across Save and Cancel, and nothing goes to the bin", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic edit history" })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    const versionId = sent.entry.version.id
    const target = { _tag: "Edit", versionId } as const
    assert.strictEqual(yield* outcome(api.GetMessageDraft({ target })), "NotFound")

    // First session: the text from before the edit is the first state.
    const typed = yield* api.SaveMessageDraft({
      target,
      draftId: null,
      content: LONG,
      expectedRowVersion: null,
      expectedSession: null
    })
    const wiped = yield* api.SaveMessageDraft({
      target,
      draftId: typed.id,
      content: "short",
      expectedRowVersion: typed.rowVersion,
      expectedSession: typed.session
    })
    assert.deepStrictEqual(
      (yield* api.MessageDraftHistory({ target, limit: 100 })).map((s) => s.length),
      ["short".length, LONG.length, "original".length]
    )
    const amended = yield* api.AmendVersion({
      versionId,
      content: "short",
      expectedRowVersion: 1,
      draft: { draftId: wiped.id, session: wiped.session }
    })
    assert.strictEqual(amended.content, "short")

    // Saved: the draft rests with its text and every state, and the bin gets nothing.
    const resting = yield* api.GetMessageDraft({ target })
    assert.strictEqual(resting.status, "committed")
    assert.strictEqual(resting.content, "short")
    assert.strictEqual(resting.id, wiped.id)
    assert.deepStrictEqual(
      (yield* api.MessageDraftHistory({ target, limit: 100 })).map((s) => s.length),
      ["short".length, LONG.length, "original".length]
    )
    assert.deepStrictEqual(yield* api.ListRecoveredTexts({ limit: 10, before: null }), [])

    // Reopened (the editor names no draft yet): typing goes on in the same history.
    const reopened = yield* api.SaveMessageDraft({
      target,
      draftId: null,
      content: "short, and more",
      expectedRowVersion: null,
      expectedSession: null
    })
    assert.strictEqual(reopened.id, wiped.id)
    assert.strictEqual(reopened.status, "active")
    const states = yield* api.MessageDraftHistory({ target, limit: 100 })
    assert.strictEqual(states.length, 4)
    // Paged: the states before a seq.
    assert.deepStrictEqual(
      (yield* api.MessageDraftHistory({ target, limit: 100, before: states[1]!.seq })).map((s) => s.length),
      [LONG.length, "original".length]
    )

    // Cancel goes back to the saved text as a state; the text cancelled is one step back.
    const cancelled = yield* api.DiscardMessageDraft({
      target,
      draftId: reopened.id,
      expectedRowVersion: reopened.rowVersion
    })
    assert.strictEqual(cancelled.recovered, 0)
    assert.strictEqual(cancelled.content, "short")
    const after = yield* api.MessageDraftHistory({ target, limit: 100 })
    assert.deepStrictEqual(
      after.map((s) => [s.kind, s.length]),
      [
        ["revision", "short".length],
        ["edit", "short, and more".length],
        ["edit", "short".length],
        ["edit", LONG.length],
        ["initial", "original".length]
      ]
    )
    assert.deepStrictEqual(yield* api.ListRecoveredTexts({ limit: 10, before: null }), [])

    // The text from before the last save is put back as the newest state, append-only.
    const draft = yield* api.GetMessageDraft({ target })
    const restored = yield* api.RestoreMessageDraft({
      target,
      draftId: draft.id,
      seq: after[3]!.seq,
      expectedRowVersion: draft.rowVersion
    })
    assert.strictEqual(restored.content, LONG)
    assert.strictEqual(restored.status, "active")
    assert.strictEqual((yield* api.MessageDraftHistory({ target, limit: 100 })).length, after.length + 1)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("a no-op saved edit keeps its initial state when the version changes elsewhere", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic unchanged save" })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    const versionId = sent.entry.version.id
    const target = { _tag: "Edit", versionId } as const
    // Typing and removing a character before autosave leaves an unchanged first draft.
    const typed = yield* api.SaveMessageDraft({
      target,
      draftId: null,
      content: "original",
      expectedRowVersion: null,
      expectedSession: null
    })
    yield* api.AmendVersion({
      versionId,
      content: "original",
      expectedRowVersion: 1,
      draft: { draftId: typed.id, session: typed.session }
    })
    yield* api.AmendVersion({ versionId, content: "changed elsewhere", expectedRowVersion: 1 })
    const reopened = yield* api.SaveMessageDraft({
      target,
      draftId: null,
      content: "typed after the external change",
      expectedRowVersion: null,
      expectedSession: null
    })
    const states = yield* api.MessageDraftHistory({ target, limit: 100 })
    assert.deepStrictEqual(
      states.map((s) => s.length),
      ["typed after the external change".length, "changed elsewhere".length, "original".length]
    )
    const restored = yield* api.RestoreMessageDraft({
      target,
      draftId: reopened.id,
      seq: states.at(-1)!.seq,
      expectedRowVersion: reopened.rowVersion
    })
    assert.strictEqual(restored.content, "original")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("a resting edit typed on a version changed elsewhere first takes the version's text", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic amended elsewhere" })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    const versionId = sent.entry.version.id
    const target = { _tag: "Edit", versionId } as const
    const typed = yield* api.SaveMessageDraft({
      target,
      draftId: null,
      content: "first edit",
      expectedRowVersion: null,
      expectedSession: null
    })
    const amended = yield* api.AmendVersion({
      versionId,
      content: "first edit",
      expectedRowVersion: 1,
      draft: { draftId: typed.id, session: typed.session }
    })
    // Amended again without this edit (another way in): the box opens on that text.
    yield* api.AmendVersion({ versionId, content: "changed elsewhere", expectedRowVersion: amended.rowVersion })
    yield* api.SaveMessageDraft({
      target,
      draftId: null,
      content: "changed elsewhere, typed on",
      expectedRowVersion: null,
      expectedSession: null
    })
    assert.deepStrictEqual(
      (yield* api.MessageDraftHistory({ target, limit: 100 })).map((s) => [s.kind, s.length]),
      [
        ["edit", "changed elsewhere, typed on".length],
        ["revision", "changed elsewhere".length],
        ["edit", "first edit".length],
        ["initial", "original".length]
      ]
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("saving an edit as a new version moves its history to that version", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic new version" })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    const source = { _tag: "Edit", versionId: sent.entry.version.id } as const
    const typed = yield* api.SaveMessageDraft({
      target: source,
      draftId: null,
      content: "edited as a new version",
      expectedRowVersion: null,
      expectedSession: null
    })
    const edited = yield* api.EditVersion({
      slotId: sent.entry.slotId,
      sourceVersionId: sent.entry.version.id,
      content: "edited as a new version",
      expectedRowVersion: sent.entry.rowVersion,
      draft: { draftId: typed.id, session: typed.session }
    })
    const next = { _tag: "Edit", versionId: edited.version.id } as const
    const moved = yield* api.GetMessageDraft({ target: next })
    assert.strictEqual(moved.id, typed.id)
    assert.strictEqual(moved.status, "committed")
    assert.deepStrictEqual(
      (yield* api.MessageDraftHistory({ target: next, limit: 100 })).map((s) => s.length),
      ["edited as a new version".length, "original".length]
    )
    // The source version's edit starts afresh.
    assert.strictEqual(yield* outcome(api.GetMessageDraft({ target: source })), "NotFound")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("a summary edit keeps its states across Save, Cancel and another revision picked", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const user = yield* api.Whoami()
    const chat = yield* api.CreateChat({ title: "Synthetic summary history" })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    const summary = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [
      { slotId: sent.entry.slotId, versionId: sent.entry.version.id, amendCount: 0 }
    ])
    const key = { forkId: chat.currentForkId!, summaryId: summary.id }
    const generated = summary.content ?? ""
    const typed = yield* api.SaveSummaryDraft({
      ...key,
      draftId: null,
      content: "my summary",
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: summary.revisionId
    })
    const edited = yield* api.EditSummary({
      ...key,
      content: "my summary",
      expectedRowVersion: summary.rowVersion,
      commitDraft: { draftId: typed.id, session: typed.session }
    })
    assert.strictEqual(edited.recovered, 0)
    const resting = (yield* api.GetSummaryDraft(key))!
    assert.strictEqual(resting.status, "committed")
    assert.deepStrictEqual(
      (yield* api.SummaryDraftHistory({ ...key, limit: 100 })).map((s) => s.length),
      ["my summary".length, generated.length]
    )

    // The generated revision picked again: typing from it first takes its text, as a state.
    const revisions = yield* api.ListSummaryRevisions({ summaryId: summary.id })
    const first = revisions.find((r) => r.origin === "generated")!
    const picked = yield* api.SelectSummaryRevision({
      ...key,
      revisionId: first.id,
      expectedRowVersion: edited.summary.rowVersion
    })
    const again = yield* api.SaveSummaryDraft({
      ...key,
      draftId: resting.id,
      content: `${generated} More.`,
      expectedRowVersion: resting.rowVersion,
      expectedSession: resting.session,
      baseRevisionId: picked.revisionId
    })
    assert.deepStrictEqual(
      (yield* api.SummaryDraftHistory({ ...key, limit: 100 })).map((s) => [s.kind, s.length]),
      [
        ["edit", `${generated} More.`.length],
        ["revision", generated.length],
        ["edit", "my summary".length],
        ["initial", generated.length]
      ]
    )

    // Cancel: back to the revision's text, the cancelled text one step back, nothing to the bin.
    const cancelled = yield* api.DiscardSummaryDraft({
      ...key,
      draftId: again.id,
      expectedRowVersion: again.rowVersion
    })
    assert.strictEqual(cancelled.recovered, 0)
    assert.strictEqual(cancelled.content, generated)
    const states = yield* api.SummaryDraftHistory({ ...key, limit: 100 })
    assert.strictEqual(states.length, 5)
    assert.deepStrictEqual(yield* api.ListRecoveredTexts({ limit: 10, before: null }), [])
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
})
