// A chat's own note is tied to its branch (owner, 2026-11-01): each branch has its own unsaved
// text, a change applies from the branch's latest message on (or, at an earlier message, only up
// to the next one), and History says where each change took effect. Synthetic text only.
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
      assert.strictEqual(mine.chatNote!.message, 1)
      assert.isTrue(mine.chatNote!.latest)
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

  it.live("a change at an earlier message applies up to the next one; later messages keep theirs", () =>
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
      const third = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          forkId: fork,
          parentSlotId: second.entry.slotId,
          branch: false,
          content: "Three."
        })
      )
      const note = yield* api.CreateChatNote({ chatId: chat.id, forkId: fork, title: "Weather" })
      const latest: ChatNotePosition = { chatId: chat.id, forkId: fork, slotId: third.entry.slotId }
      yield* type(api, note.id, latest, "Fog.")
      yield* save(api, note.id, latest)
      const earlier: ChatNotePosition = { chatId: chat.id, forkId: fork, slotId: first.entry.slotId }
      const opened = yield* api.OpenEditor({ refId: note.id, chatNote: earlier })
      assert.isFalse(opened.chatNote!.latest)
      assert.strictEqual(opened.chatNote!.message, 1)
      // What's typed at the earlier message isn't the latest message's unsaved text.
      yield* type(api, note.id, earlier, "Sun at the start.")
      assert.isUndefined(
        (yield* api.OpenEditor({ refId: note.id, chatNote: latest })).drafts.find(
          (d) => d.key.field === CONTENT && d.status === "active"
        )
      )
      yield* save(api, note.id, earlier)
      const at = (slotId: string) =>
        Effect.map(
          api.OpenEditor({ refId: note.id, chatNote: { chatId: chat.id, forkId: fork, slotId: slotId as never } }),
          (o) => o.doc.content
        )
      assert.strictEqual(yield* at(first.entry.slotId), "Sun at the start.")
      // The message after it is bound to what it had: the empty note before the fog.
      assert.strictEqual(yield* at(second.entry.slotId), "")
      assert.strictEqual(yield* at(third.entry.slotId), "Fog.")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
