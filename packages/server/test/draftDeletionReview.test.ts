import { assert, it } from "@effect/vitest"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
it.live("a deletion barrier must remain at the source when a saved edit moves history", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic deletion movement" })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "original" })
    )
    const target = { _tag: "Edit", versionId: sent.entry.version.id } as const
    const first = yield* api.SaveMessageDraft({
      target,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: "deleted text"
    })
    const stale = {
      target,
      draftId: first.id,
      expectedRowVersion: first.rowVersion,
      expectedSession: first.session,
      content: "deleted text from offline A"
    }
    const cleared = yield* api.SaveMessageDraft({ ...stale, content: "" })
    assert.isAbove(cleared.clearedVersion!, 0)
    const fresh = yield* api.SaveMessageDraft({
      ...stale,
      expectedRowVersion: cleared.rowVersion,
      content: "replacement"
    })
    const historyBefore = yield* api.MessageDraftHistory({ target, limit: 100 })
    const edited = yield* api.EditVersion({
      slotId: sent.entry.slotId,
      sourceVersionId: sent.entry.version.id,
      content: "replacement",
      expectedRowVersion: sent.entry.rowVersion,
      draft: { draftId: fresh.id, session: fresh.session }
    })
    const replay = yield* api.SaveMessageDraft(stale)
    assert.notStrictEqual(replay.content, stale.content, "stale text must never reopen on the old version")
    assert.strictEqual(replay.status, "committed")
    assert.strictEqual(replay.content, "original")
    const unidentified = yield* api.SaveMessageDraft({ ...stale, draftId: null })
    assert.strictEqual(
      unidentified.status,
      "committed",
      "a legacy counter without its original identity cannot authorize the replacement source row"
    )
    const movedTarget = { _tag: "Edit", versionId: edited.version.id } as const
    const moved = yield* api.GetMessageDraft({ target: movedTarget })
    assert.strictEqual(moved.id, fresh.id)
    assert.deepStrictEqual(yield* api.MessageDraftHistory({ target: movedTarget, limit: 100 }), historyBefore)
    // Both a copy typed after the source deletion and a new editor at the retained row
    // can still save; neither has to borrow the moved history's current version.
    const afterDeletion = yield* api.SaveMessageDraft({
      ...stale,
      expectedRowVersion: fresh.rowVersion,
      content: "fresh offline keystroke"
    })
    assert.strictEqual(afterDeletion.content, "fresh offline keystroke")
    const freshSource = yield* api.SaveMessageDraft({
      ...stale,
      draftId: afterDeletion.id,
      expectedRowVersion: afterDeletion.rowVersion,
      expectedSession: afterDeletion.session,
      content: "new source editor"
    })
    assert.strictEqual(freshSource.content, "new source editor")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("deleting one text field in a JSON user draft must defeat an older form copy", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "connection:new", field: "Settings" }
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: JSON.stringify({ name: "deleted name", baseUrl: "https://example.invalid" })
    })
    const stale = {
      ...address,
      draftId: first.id,
      expectedRowVersion: first.rowVersion,
      expectedSession: first.session,
      content: JSON.stringify({ name: "deleted name", baseUrl: "https://example.invalid/last-keystroke" })
    }
    const cleared = yield* api.SaveUserDraft({
      ...stale,
      content: JSON.stringify({ name: "", baseUrl: "https://example.invalid" })
    })
    assert.strictEqual(JSON.parse(cleared.content).name, "")
    // A stale form is refused whole (owner, 2026-11-24): the deletion stands, the copy is offered back.
    const replay = yield* api.SaveUserDraft(stale)
    assert.deepStrictEqual(JSON.parse(replay.content), { name: "", baseUrl: "https://example.invalid" })
    assert.strictEqual(replay.refused?.content, stale.content)
    // Fresh deliberate typing is allowed, and its new protected value survives another old form.
    const fresh = yield* api.SaveUserDraft({
      ...stale,
      expectedRowVersion: replay.rowVersion,
      content: JSON.stringify({ name: "replacement name", baseUrl: "https://example.invalid/last-keystroke" })
    })
    assert.strictEqual(JSON.parse(fresh.content).name, "replacement name")
    yield* api.EndUserDraft({
      ...address,
      draftId: fresh.id,
      expectedRowVersion: fresh.rowVersion,
      outcome: "committed"
    })
    const afterCommit = yield* api.SaveUserDraft(stale)
    assert.deepStrictEqual(JSON.parse(afterCommit.content), {
      name: "replacement name",
      baseUrl: "https://example.invalid/last-keystroke"
    })
    assert.isAbove((yield* api.ListRecoveredTexts({ limit: 100, before: null })).length, 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("clearing nested or removed form inputs protects only those inputs", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const ownerId = (yield* api.Whoami()).id
    for (const [index, cleared] of [{ info: { name: "" } }, { info: { name: null } }, { info: {} }, {}].entries()) {
      const address = { ownerId, targetId: `nested-form:${index}`, field: "Settings" }
      const first = yield* api.SaveUserDraft({
        ...address,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        content: JSON.stringify({ info: { name: "deleted nested name" }, notes: "kept" })
      })
      const base = {
        ...address,
        draftId: first.id,
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session
      }
      const clear = yield* api.SaveUserDraft({ ...base, content: JSON.stringify({ ...cleared, notes: "kept" }) })
      const stale = JSON.stringify({ info: { name: "deleted nested name" }, notes: "last keystroke" })
      const replay = yield* api.SaveUserDraft({ ...base, content: stale })
      // Refused whole (owner, 2026-11-24): the clear stands, and the stale copy is offered back.
      assert.strictEqual(replay.content, clear.content)
      assert.strictEqual(replay.refused?.content, stale)
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("moving a library edit to a variant also leaves its original input's barrier", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Synthetic noted card", name: "Synthetic noted card" })
    const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Synthetic moved note" })
    const opened = yield* api.OpenEditor({ refId: note.id })
    const field = '["content"]'
    const first = yield* api.SaveEditorDraft({
      refId: note.id,
      field,
      content: "deleted note",
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: opened.ref.headRevisionId
    })
    const stale = {
      refId: note.id,
      field,
      content: "deleted offline note",
      draftId: first.id,
      expectedRowVersion: first.rowVersion,
      expectedSession: first.session,
      baseRevisionId: first.baseRevision as typeof opened.ref.headRevisionId
    }
    const cleared = yield* api.SaveEditorDraft({ ...stale, content: "" })
    const fresh = yield* api.SaveEditorDraft({
      ...stale,
      expectedRowVersion: cleared.rowVersion,
      content: "replacement note"
    })
    const variant = yield* api.ForkVariant({
      refId: note.id,
      label: "Synthetic variant",
      subtitle: "",
      moveDrafts: true
    })
    const moved = yield* api.OpenEditor({ refId: variant.id })
    assert.strictEqual(moved.drafts.find((d) => d.id === fresh.id)?.content, "replacement note")
    const replay = yield* api.SaveEditorDraft(stale)
    assert.notStrictEqual(replay.content, stale.content)
    assert.strictEqual(replay.status, "committed")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("replaying a form initialization cannot delete the keystrokes already saved from it", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const ownerId = (yield* api.Whoami()).id
    const address = { ownerId, targetId: "connection:initialization", field: "Settings" }
    const content = JSON.stringify({ name: "", baseUrl: "" })
    const first = yield* api.SaveUserDraft({
      ...address,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content
    })
    const base = { ...address, draftId: first.id, expectedRowVersion: first.rowVersion, expectedSession: first.session }
    const typed = JSON.stringify({ name: "last keystroke", baseUrl: "" })
    yield* api.SaveUserDraft({ ...base, content: typed })
    const seeded = yield* api.SaveUserDraft({ ...base, content, seed: true })
    assert.deepStrictEqual(seeded.deletions, {})
    const replay = yield* api.SaveUserDraft({ ...base, content: typed })
    assert.strictEqual(replay.content, typed)
    const cleared = yield* api.SaveUserDraft({ ...base, expectedRowVersion: replay.rowVersion, content })
    const oldSeed = yield* api.SaveUserDraft({
      ...base,
      expectedRowVersion: cleared.rowVersion,
      content: typed,
      seed: true
    })
    assert.strictEqual(
      oldSeed.content,
      content,
      "initialization cannot overwrite protected fields even on a newer base"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("an empty reply of several dropped files what was typed into its own swipe", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id
    const chat = yield* api.CreateChat({ title: "Synthetic empty reply" })
    const running = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      parentSlotId: null,
      branch: false,
      version: new NewVersion({
        content: "",
        speakerEntityId: null,
        writer: "model",
        status: "generating",
        origin: "generated",
        macroMode: "verbatim"
      }),
      commitDraft: null
    })
    // "Write your own swipe" on the reply while it's being written, then cleared: the text is
    // only in its draft's history.
    const target = { _tag: "Write", slotId: running.slotId } as const
    const typed = "A swipe of my own, typed while the reply was still coming."
    const first = yield* api.SaveMessageDraft({
      target,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      content: typed
    })
    yield* api.SaveMessageDraft({
      target,
      draftId: first.id,
      expectedRowVersion: first.rowVersion,
      expectedSession: first.session,
      content: ""
    })
    yield* writer.FinishGeneration({
      userId,
      versionId: running.version.id,
      content: "",
      status: "complete",
      error: null,
      discardEmpty: true
    })
    const recovered = yield* api.ListRecoveredTexts({ limit: 10, before: null })
    assert.include(
      recovered.map((text) => text.content),
      typed
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
