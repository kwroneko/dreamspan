// Snippets (owner, 2026-11-01): shared notes for "This chat" (every branch of it) or "All chats",
// edited as every library field is: typing is live and keeps an edit history, and a revision is
// cut only by Save (or a reply that uses changed text). Synthetic text only.
import { assert, describe, it } from "@effect/vitest"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { client, outcome, testConfig, withServer } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const CONTENT = textField(["content"])

/** Text typed into a snippet, as its editor saves it. */
const type = (api: Api, refId: RefId, content: string, field = CONTENT) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    const draft = opened.drafts.find((d) => d.key.field === field)
    return yield* api.SaveEditorDraft({
      refId,
      field,
      draftId: draft?.id ?? null,
      content,
      expectedRowVersion: draft?.rowVersion ?? null,
      expectedSession: draft?.session ?? null,
      baseRevisionId: draft?.status === "active" ? (draft.baseRevision as never) : opened.ref.headRevisionId
    })
  })

/** The editor's Save: every changed field as one revision. */
const save = (api: Api, refId: RefId) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    return yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: opened.ref.rowVersion,
      fields: opened.drafts
        .filter((d) => d.status === "active")
        .map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
      message: null
    })
  })

describe("snippets", () => {
  it.live("a chat's snippet is in every branch of it, typing is live, and only Save cuts a revision", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Snippet fixture" })
      const earlier = (yield* api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: null })).fork
      const made = yield* api.CreateSnippet({ chatId: chat.id, title: "Harbour", content: "Rain." })
      assert.strictEqual(made.global, false)
      // A fork made before it and one made after both list it: it's the chat's, not a branch's.
      const later = (yield* api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: null })).fork
      assert.isDefined(earlier)
      assert.isDefined(later)
      assert.strictEqual((yield* api.ListSnippets({ chatId: chat.id }))[0]!.content, "Rain.")
      // Another chat doesn't.
      const other = yield* api.CreateChat({ title: "Other chat" })
      assert.deepStrictEqual(yield* api.ListSnippets({ chatId: other.id }), [])

      const revisions = () => api.ListRevisions({ refId: made.ref.id, limit: 50 })
      yield* type(api, made.ref.id, "Sunrise.")
      yield* type(api, made.ref.id, "Sunrise over the quay.")
      yield* type(api, made.ref.id, "Harbour at dawn", textField(["title"]))
      // Live: the list shows what's typed; no revision was cut by typing.
      const listed = (yield* api.ListSnippets({ chatId: chat.id, query: "QUAY" }))[0]!
      assert.strictEqual(listed.content, "Sunrise over the quay.")
      assert.strictEqual(listed.title, "Harbour at dawn")
      assert.lengthOf(yield* revisions(), 1)
      // The edit history keeps every state, past a Save too.
      const states = yield* api.EditorDraftHistory({ refId: made.ref.id, field: CONTENT, limit: 50 })
      assert.isAtLeast(states.length, 2)
      yield* save(api, made.ref.id)
      assert.lengthOf(yield* revisions(), 2)
      assert.strictEqual((yield* api.OpenEditor({ refId: made.ref.id })).doc.content, "Sunrise over the quay.")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("moves between This chat and All chats; narrowing one another chat shows is refused", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Scope" })
      const other = yield* api.CreateChat({ title: "Elsewhere" })
      const made = yield* api.CreateSnippet({ chatId: chat.id, title: "Weather", content: "Rain." })
      const global = yield* api.SetSnippetScope({ chatId: chat.id, refId: made.ref.id, global: true })
      assert.isTrue(global.global)
      assert.strictEqual((yield* api.ListSnippets({ chatId: other.id }))[0]!.ref.id, made.ref.id)
      assert.strictEqual((yield* api.ListSnippets({ chatId: null }))[0]!.ref.id, made.ref.id)
      // Back to the chat while nothing elsewhere shows it.
      const back = yield* api.SetSnippetScope({ chatId: chat.id, refId: made.ref.id, global: false })
      assert.isFalse(back.global)
      assert.deepStrictEqual(yield* api.ListSnippets({ chatId: other.id }), [])
      // Shown by another chat's note: it stays for all chats.
      yield* api.SetSnippetScope({ chatId: chat.id, refId: made.ref.id, global: true })
      yield* api.CreateChatNote({
        chatId: other.id,
        forkId: other.currentForkId,
        title: "Weather",
        link: made.ref.entityId
      })
      assert.strictEqual(
        yield* outcome(api.SetSnippetScope({ chatId: chat.id, refId: made.ref.id, global: false })),
        "EditRefused"
      )
      // A snippet of its own needs a chat.
      const loose = yield* api.CreateSnippet({ chatId: null, title: "Loose", content: "" })
      assert.strictEqual(
        yield* outcome(api.SetSnippetScope({ chatId: null, refId: loose.ref.id, global: false })),
        "EditRefused"
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("a note linked to a chat's snippet sends its saved text in every branch", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const chat = yield* api.CreateChat({ title: "Scoped note assembly" })
      const scope = { chatId: chat.id, forkId: chat.currentForkId }
      const sent = yield* api.SendMessage({ ...scope, parentSlotId: null, branch: false, content: "At the quay." })
      assert.strictEqual(sent._tag, "Posted")
      if (sent._tag !== "Posted") return
      const made = yield* api.CreateSnippet({ chatId: chat.id, title: "Weather", content: "SNIPPET_RAIN" })
      const slot = yield* api.CreateChatNote({ ...scope, title: "Weather", link: made.ref.entityId })
      yield* api.ChangeCast({ ...scope, slotId: null, change: { _tag: "Note", entityId: slot.entityId, active: true } })
      const child = (yield* api.CreateFork({ ...scope, fromForkId: scope.forkId, atSlotId: sent.entry.slotId })).fork
      const inspect = (forkId: typeof scope.forkId) =>
        reader.AssembleContext({
          ...scope,
          forkId,
          userId,
          slotId: sent.entry.slotId,
          versionId: sent.entry.version.id,
          now: 1000,
          timeZone: "UTC",
          frozen: null
        })
      const text = (json: string) =>
        (JSON.parse(json) as ContextSnapshot).request.messages.map((message) => message.content).join("\n")
      const frozen = yield* inspect(scope.forkId)
      assert.include(text(frozen.snapshot), "SNIPPET_RAIN")
      yield* type(api, made.ref.id, "SNIPPET_SUNRISE")
      yield* save(api, made.ref.id)
      assert.include(text((yield* inspect(scope.forkId)).snapshot), "SNIPPET_SUNRISE")
      assert.include(text((yield* inspect(child.id)).snapshot), "SNIPPET_SUNRISE")
      // A context built again reads what it read then.
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: frozen.snapshot })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.strictEqual(text(rebuilt.snapshot), text(frozen.snapshot))
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live("lists existing shared notes, creates globals outside chats, and purges drafts with the note", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const old = yield* api.CreateSharedNote({ title: "Old shared note", content: "A shared text" })
      assert.strictEqual((yield* api.ListSnippets({ chatId: null }))[0]!.ref.id, old.id)
      const made = yield* api.CreateSnippet({ chatId: null, title: "New global", content: "Some text" })
      assert.isTrue(made.global)
      yield* type(api, made.ref.id, "Private synthetic text")
      assert.isTrue((yield* reader.ListActiveDrafts({ userId })).some((draft) => draft.key.targetId === made.ref.id))
      const binned = yield* api.DeleteNote({ noteRefId: made.ref.id })
      assert.isFalse((yield* api.ListSnippets({ chatId: null })).some((item) => item.ref.id === made.ref.id))
      yield* api.PurgeBinItem({ itemId: binned.id })
      assert.isFalse((yield* reader.ListActiveDrafts({ userId })).some((draft) => draft.key.targetId === made.ref.id))
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
