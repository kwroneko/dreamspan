// Copying saved chat notes keeps the destination's saved text reachable in History.
import { assert, it } from "@effect/vitest"
import { textField } from "@dreamspan/shared/editing.ts"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"

it.live("a note copy retains the destination revision in History and can be restored", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic note copies" })
    const from = chat.currentForkId!
    const note = yield* api.CreateChatNote({ chatId: chat.id, forkId: from, title: "Weather", content: "Original" })
    const to = (yield* api.CreateFork({ chatId: chat.id, fromForkId: from, atSlotId: null })).fork.id
    const position = (forkId: typeof from) => ({ chatId: chat.id, forkId, slotId: null })
    const save = (forkId: typeof from, content: string) =>
      Effect.gen(function* () {
        const opened = yield* api.OpenEditor({ refId: note.id, chatNote: position(forkId) })
        const draft = yield* api.SaveEditorDraft({
          refId: note.id,
          scope: opened.chatNote!.scope,
          field: textField(["content"]),
          content,
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: opened.ref.headRevisionId
        })
        const result = yield* api.CommitEditorDrafts({
          refId: note.id,
          chatNote: position(forkId),
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
        return result.ref.headRevisionId
      })
    const previous = yield* save(to, "Rain on this branch")
    yield* save(from, "Sun on the other branch")
    const copy = { chatId: chat.id, noteRefId: note.id, fromForkId: from, toForkId: to }
    assert.isTrue(yield* api.CopyNoteToBranch(copy))
    const history = yield* api.ListRevisions({ refId: note.id, chatNote: position(to), limit: 100 })
    assert.include(
      history.map((revision) => revision.id),
      previous
    )
    assert.isFalse(yield* api.CopyNoteToBranch(copy), "copying identical saved content is a no-op")
    const opened = yield* api.OpenEditor({ refId: note.id, chatNote: position(to) })
    yield* api.RestoreRevision({
      refId: note.id,
      revisionId: previous,
      expectedRowVersion: opened.ref.rowVersion,
      chatNote: position(to)
    })
    assert.strictEqual(
      (yield* api.OpenEditor({ refId: note.id, chatNote: position(to) })).doc.content,
      "Rain on this branch"
    )
    assert.strictEqual(
      (yield* api.OpenEditor({ refId: note.id, chatNote: position(from) })).doc.content,
      "Sun on the other branch"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.live("opening a chat note rejects a binned branch whose tip is still shared", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Synthetic note branch" })
    const main = chat.currentForkId!
    const sent = yield* api.SendMessage({
      chatId: chat.id,
      parentSlotId: null,
      branch: false,
      content: "A shared tip.",
      reply: false
    })
    if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
    const slotId = sent.entry.slotId
    const note = yield* api.CreateChatNote({ chatId: chat.id, forkId: main, title: "Weather", content: "Sun" })
    const forkId = (yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: slotId })).fork.id
    const editor = { refId: note.id, chatNote: { chatId: chat.id, forkId, slotId } }
    assert.equal((yield* api.OpenEditor(editor)).chatNote?.scope, forkId)

    yield* api.DeleteFork({ forkId })
    const gone = yield* Effect.flip(api.OpenEditor(editor))
    assert.equal(gone._tag, "NotFound")
    assert.equal(
      (yield* api.OpenEditor({ ...editor, chatNote: { ...editor.chatNote, forkId: main } })).doc.content,
      "Sun"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)
