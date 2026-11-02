// Unsaved note text goes with a fork (owner, 2026-11-02): the new branch, or the card's fork,
// gets it, still unsaved; the source goes back to its last revision, the moved text one step
// back in its edit history. Forking from an earlier message after a saved change, the note's
// "As it is now" takes the text and "As it was then" leaves it. Synthetic text only.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import { canonicalJson, textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { client, posted, testConfig, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const CONTENT = textField(["content"])

/** Typed into the note's editor at `at` (none: a card's note), on that position's drafts. */
const type = (api: Api, refId: RefId, at: ChatNotePosition | undefined, content: string) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId, ...(at ? { chatNote: at } : {}) })
    const draft = opened.drafts.find((d) => d.key.field === CONTENT)
    return yield* api.SaveEditorDraft({
      refId,
      field: CONTENT,
      ...(opened.chatNote ? { scope: opened.chatNote.scope } : {}),
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

/** What the editor shows at `at`: the saved text and the unsaved text, if any. */
const shown = (api: Api, refId: RefId, at?: ChatNotePosition) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId, ...(at ? { chatNote: at } : {}) })
    const draft = opened.drafts.find((d) => d.key.field === CONTENT && d.status === "active")
    return { saved: opened.doc.content as string, unsaved: draft?.content ?? null, scope: opened.chatNote?.scope }
  })

/** The field's edit history at `at`, and restoring the state that holds `text`. */
const restoreFromHistory = (api: Api, refId: RefId, at: ChatNotePosition | undefined, text: string) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId, ...(at ? { chatNote: at } : {}) })
    const scope = opened.chatNote ? { scope: opened.chatNote.scope } : {}
    const draft = opened.drafts.find((d) => d.key.field === CONTENT)!
    const states = yield* api.EditorDraftHistory({ refId, field: CONTENT, ...scope, limit: 50 })
    for (const state of states) {
      const full = yield* api.EditorDraftState({ refId, field: CONTENT, ...scope, seq: state.seq })
      if (full !== text) continue
      return yield* api.RestoreEditorDraft({
        refId,
        field: CONTENT,
        ...scope,
        draftId: draft.id,
        seq: state.seq,
        expectedRowVersion: draft.rowVersion
      })
    }
    return assert.fail(`no state holds ${text}`)
  })

const chatWithNote = Effect.gen(function* () {
  const api = yield* client()
  const chat = yield* api.CreateChat({ title: "Carry" })
  const main = chat.currentForkId!
  const first = yield* posted(
    api.SendMessage({ chatId: chat.id, forkId: main, parentSlotId: null, branch: false, content: "At the quay." })
  )
  const note = yield* api.CreateChatNote({ chatId: chat.id, forkId: main, title: "Weather" })
  const at = (forkId: ForkId, slotId: SlotId | null): ChatNotePosition => ({ chatId: chat.id, forkId, slotId })
  return { api, chat, chatId: chat.id as ChatId, main, first: first.entry.slotId, note, at }
})

describe("unsaved note text and forks", () => {
  it.live("a branch at the latest message takes it; the source goes back, with it in its history", () =>
    Effect.gen(function* () {
      const { api, chatId, main, first, note, at } = yield* chatWithNote
      yield* type(api, note.id, at(main, first), "Fog over the harbour.")
      yield* save(api, note.id, at(main, first))
      yield* type(api, note.id, at(main, first), "Fog, then rain.")

      const made = yield* api.CreateFork({ chatId, fromForkId: main, atSlotId: first })
      const there = yield* shown(api, note.id, at(made.fork.id, first))
      assert.deepStrictEqual([there.saved, there.unsaved], ["Fog over the harbour.", "Fog, then rain."])
      // The branch's own history starts at the saved text, so going back there works too.
      const branchHistory = yield* api.EditorDraftHistory({
        refId: note.id,
        field: CONTENT,
        scope: there.scope!,
        limit: 10
      })
      assert.isAtLeast(branchHistory.length, 2)

      const source = yield* shown(api, note.id, at(main, first))
      assert.deepStrictEqual([source.saved, source.unsaved], ["Fog over the harbour.", null])
      const restored = yield* restoreFromHistory(api, note.id, at(main, first), "Fog, then rain.")
      assert.strictEqual(restored.content, "Fog, then rain.")
      assert.strictEqual((yield* shown(api, note.id, at(main, first))).unsaved, "Fog, then rain.")
      // Each branch's text is its own now.
      assert.strictEqual((yield* shown(api, note.id, at(made.fork.id, first))).unsaved, "Fog, then rain.")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("sending as a branch from an earlier message takes it when the note hasn't changed since", () =>
    Effect.gen(function* () {
      const { api, chatId, main, first, note, at } = yield* chatWithNote
      const second = yield* posted(
        api.SendMessage({ chatId, forkId: main, parentSlotId: first, branch: false, content: "Later." })
      )
      yield* type(api, note.id, at(main, second.entry.slotId), "Wind from the north.")
      const branched = yield* posted(
        api.SendMessage({ chatId, forkId: main, parentSlotId: first, branch: true, content: "Elsewhere." })
      )
      const fork = (yield* api.GetChat({ chatId })).currentForkId!
      assert.notStrictEqual(fork, main)
      assert.strictEqual((yield* shown(api, note.id, at(fork, branched.entry.slotId))).unsaved, "Wind from the north.")
      assert.isNull((yield* shown(api, note.id, at(main, second.entry.slotId))).unsaved)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("from an earlier message after a saved change: now takes it, then leaves it, none leaves it", () =>
    Effect.gen(function* () {
      const { api, chatId, main, first, note, at } = yield* chatWithNote
      const second = yield* posted(
        api.SendMessage({ chatId, forkId: main, parentSlotId: first, branch: false, content: "Later." })
      )
      const tip = at(main, second.entry.slotId)
      yield* type(api, note.id, tip, "Saved later.")
      yield* save(api, note.id, tip)
      yield* type(api, note.id, tip, "Saved later, and typed on.")

      const preview = yield* api.PreviewForkNotes({ chatId, fromForkId: main, atSlotId: first })
      const row = preview.find((r) => r.note === note.entityId)!
      assert.strictEqual(row.now.content, "Saved later.")
      assert.strictEqual(row.unsaved, "Saved later, and typed on.")

      const branch = (choice: "then" | "now") =>
        api.CreateFork({
          chatId,
          fromForkId: main,
          atSlotId: first,
          notes: { comparison: canonicalJson(preview), choices: [{ note: row.note, choice }] }
        })
      // As it was then: the branch starts with the earlier text, and the typing stays here.
      const then = (yield* branch("then")).fork.id
      assert.deepStrictEqual(Object.values(yield* shown(api, note.id, at(then, first))).slice(0, 2), ["", null])
      assert.strictEqual((yield* shown(api, note.id, tip)).unsaved, "Saved later, and typed on.")
      // Without a choice (an API caller's branch): positional, as then.
      const plain = (yield* api.CreateFork({ chatId, fromForkId: main, atSlotId: first })).fork.id
      assert.isNull((yield* shown(api, note.id, at(plain, first))).unsaved)
      assert.strictEqual((yield* shown(api, note.id, tip)).unsaved, "Saved later, and typed on.")
      // As it is now: the saved text and the typing on it.
      const now = (yield* branch("now")).fork.id
      const there = yield* shown(api, note.id, at(now, first))
      assert.deepStrictEqual([there.saved, there.unsaved], ["Saved later.", "Saved later, and typed on."])
      const source = yield* shown(api, note.id, tip)
      assert.deepStrictEqual([source.saved, source.unsaved], ["Saved later.", null])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("text typed at an earlier message stays at it", () =>
    Effect.gen(function* () {
      const { api, chatId, main, first, note, at } = yield* chatWithNote
      const second = yield* posted(
        api.SendMessage({ chatId, forkId: main, parentSlotId: first, branch: false, content: "Later." })
      )
      yield* type(api, note.id, at(main, first), "Typed at the first message.")
      const made = yield* api.CreateFork({ chatId, fromForkId: main, atSlotId: second.entry.slotId })
      assert.isNull((yield* shown(api, note.id, at(made.fork.id, second.entry.slotId))).unsaved)
      assert.strictEqual((yield* shown(api, note.id, at(main, first))).unsaved, "Typed at the first message.")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("a card's fork takes its notes' unsaved text; the original goes back, with it in its history", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Mira", name: "Mira", nickname: "Mira", version: "1" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Coat" })
      yield* type(api, note.id, undefined, "A grey coat.")
      const fork = yield* api.ForkCard({
        refId: card.id,
        name: "Mira",
        nickname: "Mira",
        characterVersion: "2",
        moveDrafts: false
      })
      const copy = (yield* api.ListCardNotes({ cardRefId: fork.id })).find((entry) => entry.ref.label === "Coat")!
      const there = yield* shown(api, copy.ref.id)
      assert.deepStrictEqual([there.saved, there.unsaved], ["", "A grey coat."])
      const source = yield* shown(api, note.id)
      assert.deepStrictEqual([source.saved, source.unsaved], ["", null])
      yield* restoreFromHistory(api, note.id, undefined, "A grey coat.")
      assert.strictEqual((yield* shown(api, note.id)).unsaved, "A grey coat.")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
