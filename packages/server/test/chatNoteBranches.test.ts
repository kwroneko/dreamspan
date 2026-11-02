// A chat's own note is tied to its branch (owner, 2026-11-01): each branch has its own unsaved
// text, a change applies from the branch's latest message on, and History says where each change
// took effect. Synthetic text only.
import { assert, describe, it } from "@effect/vitest"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { client, posted, testConfig, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const CONTENT = textField(["content"])

/** Typed into the note's editor at `at`, on the branch's drafts. */
const type = (api: Api, refId: RefId, at: ChatNotePosition, content: string) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId, chatNote: at })
    const draft = opened.drafts.find((d) => d.key.field === CONTENT)
    return yield* api.SaveEditorDraft({
      refId,
      field: CONTENT,
      scope: opened.chatNote!.scope,
      draftId: draft?.id ?? null,
      content,
      expectedRowVersion: draft?.rowVersion ?? null,
      expectedSession: draft?.session ?? null,
      baseRevisionId: draft?.status === "active" ? (draft.baseRevision as never) : opened.ref.headRevisionId
    })
  })

const save = (api: Api, refId: RefId, at: ChatNotePosition) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId, chatNote: at })
    return yield* api.CommitEditorDrafts({
      refId,
      chatNote: at,
      expectedRowVersion: opened.ref.rowVersion,
      fields: opened.drafts
        .filter((d) => d.status === "active")
        .map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
      message: null
    })
  })

describe("a chat's own note on its branches", () => {
  it.live("edits at the display end when an inserted message follows the structural tip", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Trailing insertion" })
      const forkId = chat.currentForkId!
      const first = yield* posted(
        api.SendMessage({ chatId: chat.id, forkId, parentSlotId: null, branch: false, content: "One." })
      )
      const note = yield* api.CreateChatNote({ chatId: chat.id, forkId, title: "Weather" })
      const inserted = yield* api.InsertMessage({
        chatId: chat.id,
        forkId,
        anchor: first.entry.slotId,
        expectedRowVersion: first.entry.rowVersion,
        body: { _tag: "Write", speaker: null, content: "Inserted after one." }
      })
      const position = { chatId: chat.id, forkId, slotId: first.entry.slotId }
      yield* type(api, note.id, position, "Fog at the display end.")
      yield* save(api, note.id, position)
      const before = yield* api.ListChatNotes(position)
      assert.strictEqual(before.find((n) => n.ref.id === note.id)?.doc.content, "")
      const after = yield* api.ListChatNotes({ ...position, slotId: inserted.entry.slotId })
      assert.strictEqual(after.find((n) => n.ref.id === note.id)?.doc.content, "Fog at the display end.")
      assert.strictEqual(
        (yield* api.OpenEditor({ refId: note.id, chatNote: position })).doc.content,
        "Fog at the display end."
      )
      // A stale tab can still edit the current state after its named structural tip is deleted.
      yield* api.DeleteMessage({ slotId: first.entry.slotId, forkId })
      yield* type(api, note.id, position, "Sun at the display end.")
      yield* save(api, note.id, position)
      assert.strictEqual(
        (yield* api.OpenEditor({ refId: note.id, chatNote: position })).doc.content,
        "Sun at the display end."
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("keeps unsaved text per branch, says another branch differs, and History says where", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Branches" })
      const main = chat.currentForkId
      const first = yield* posted(
        api.SendMessage({ chatId: chat.id, forkId: main, parentSlotId: null, branch: false, content: "At the quay." })
      )
      const note = yield* api.CreateChatNote({ chatId: chat.id, forkId: main, title: "Weather" })
      const side = (yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: first.entry.slotId })).fork
      const here: ChatNotePosition = { chatId: chat.id, forkId: main, slotId: first.entry.slotId }
      const there: ChatNotePosition = { chatId: chat.id, forkId: side.id, slotId: first.entry.slotId }

      yield* type(api, note.id, here, "Rain on the main branch.")
      const mine = yield* api.OpenEditor({ refId: note.id, chatNote: here })
      assert.isFalse(mine.chatNote!.otherBranches)
      assert.strictEqual(mine.drafts.find((d) => d.key.field === CONTENT)!.content, "Rain on the main branch.")
      // The other branch has none of it, and is told this one differs.
      const theirs = yield* api.OpenEditor({ refId: note.id, chatNote: there })
      assert.isUndefined(theirs.drafts.find((d) => d.key.field === CONTENT && d.status === "active"))
      assert.isTrue(theirs.chatNote!.otherBranches)
      assert.notStrictEqual(theirs.chatNote!.scope, mine.chatNote!.scope)

      // Saved: this branch from its latest message on; History says so, and the other branch keeps its own.
      yield* save(api, note.id, here)
      assert.strictEqual(
        (yield* api.OpenEditor({ refId: note.id, chatNote: here })).doc.content,
        "Rain on the main branch."
      )
      assert.strictEqual((yield* api.OpenEditor({ refId: note.id, chatNote: there })).doc.content, "")
      const history = yield* api.ListRevisions({ refId: note.id, limit: 10, chatNote: here })
      assert.deepStrictEqual(history[0]!.changedAt, [{ message: 1, thisBranch: true }])
      const elsewhere = yield* api.ListRevisions({ refId: note.id, limit: 10, chatNote: there })
      assert.isUndefined(elsewhere[0]!.changedAt?.find((at) => at.thisBranch && at.message === 1))
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("an edit is always at the branch's latest message, whatever position the editor names", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Earlier point" })
      const fork = chat.currentForkId
      const first = yield* posted(
        api.SendMessage({ chatId: chat.id, forkId: fork, parentSlotId: null, branch: false, content: "One." })
      )
      const second = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          forkId: fork,
          parentSlotId: first.entry.slotId,
          branch: false,
          content: "Two."
        })
      )
      const note = yield* api.CreateChatNote({ chatId: chat.id, forkId: fork, title: "Weather" })
      const latest: ChatNotePosition = { chatId: chat.id, forkId: fork, slotId: second.entry.slotId }
      yield* type(api, note.id, latest, "Fog.")
      yield* save(api, note.id, latest)
      // Named with an earlier message (a stale tab's), the editor still shows and edits the
      // branch's current note, with the same unsaved text (owner, 2026-11-02).
      const earlier: ChatNotePosition = { chatId: chat.id, forkId: fork, slotId: first.entry.slotId }
      const opened = yield* api.OpenEditor({ refId: note.id, chatNote: earlier })
      assert.strictEqual(opened.doc.content, "Fog.")
      assert.strictEqual(
        opened.chatNote!.scope,
        (yield* api.OpenEditor({ refId: note.id, chatNote: latest })).chatNote!.scope
      )
      yield* type(api, note.id, earlier, "Fog, then sun.")
      assert.strictEqual(
        (yield* api.OpenEditor({ refId: note.id, chatNote: latest })).drafts.find(
          (d) => d.key.field === CONTENT && d.status === "active"
        )?.content,
        "Fog, then sun."
      )
      yield* save(api, note.id, earlier)
      // Saved from the latest message on: the first message still had none.
      const listed = (slotId: string) =>
        Effect.map(
          api.ListChatNotes({ chatId: chat.id, forkId: fork, slotId: slotId as never }),
          (notes) => notes.find((n) => n.ref.id === note.id)?.doc.content
        )
      assert.strictEqual(yield* listed(first.entry.slotId), "")
      assert.strictEqual(yield* listed(second.entry.slotId), "Fog, then sun.")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
