// Synthetic snippet text only. These are shared notes, with fork-local text bindings.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { client, outcome, testConfig, withServer } from "./support/config.ts"

describe("snippets", () => {
  it.live("keeps the current library revision when restoring a shared note's snippet history", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const scope = { chatId: null, forkId: null }
      const made = yield* api.CreateSnippet({ ...scope, title: "Shared history", content: "First text." })
      yield* api.SaveSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: made.revision,
        title: made.title,
        content: "Second passage."
      })
      const opened = yield* api.OpenEditor({ refId: made.ref.id })
      yield* api.RestoreRevision({
        refId: made.ref.id,
        revisionId: made.revision,
        expectedRowVersion: opened.ref.rowVersion
      })
      const current = (yield* api.ListSnippets(scope))[0]!
      const history = yield* api.SnippetHistory({ ...scope, refId: made.ref.id, limit: 10 })
      assert.deepStrictEqual(
        history.map((state) => state.length),
        ["First text.".length, "Second passage.".length, "First text.".length]
      )
      yield* api.RestoreSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: current.revision,
        seq: history[1]!.seq
      })
      assert.strictEqual((yield* api.ListSnippets(scope))[0]!.content, "Second passage.")
      const after = yield* api.SnippetHistory({ ...scope, refId: made.ref.id, limit: 10 })
      assert.strictEqual(after[1]!.length, "First text.".length)
      assert.strictEqual(after[1]!.kind, "restore")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("keeps the inherited or existing shared text before a snippet's first edit", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Inherited recovery" })
      const originalScope = { chatId: chat.id, forkId: chat.currentForkId }
      const made = yield* api.CreateSnippet({ ...originalScope, title: "Weather", content: "Rain before the fork." })
      const child = (yield* api.CreateFork({ ...originalScope, fromForkId: originalScope.forkId, atSlotId: null })).fork
      const old = yield* api.CreateSharedNote({ title: "Existing shared note", content: "Existing shared text." })
      for (const [scope, refId] of [
        [{ chatId: chat.id, forkId: child.id }, made.ref.id],
        [{ chatId: null, forkId: null }, old.id]
      ] as const) {
        const before = (yield* api.ListSnippets(scope)).find((item) => item.ref.id === refId)!
        const saved = yield* api.SaveSnippet({
          ...scope,
          refId,
          expectedRevision: before.revision,
          title: before.title,
          content: "Replacement."
        })
        const history = yield* api.SnippetHistory({ ...scope, refId, limit: 10 })
        assert.strictEqual(history.length, 2)
        const restored = yield* api.RestoreSnippet({
          ...scope,
          refId,
          expectedRevision: saved.revision,
          seq: history[1]!.seq
        })
        assert.strictEqual(restored.content, before.content)
      }
      assert.strictEqual(
        (yield* api.ListSnippets(originalScope)).find((item) => item.ref.id === made.ref.id)!.content,
        made.content
      )
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("a snippet's earlier text is listed and restored from the server, in its own fork only", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Snippet history" })
      const scope = { chatId: chat.id, forkId: chat.currentForkId }
      const made = yield* api.CreateSnippet({ ...scope, title: "Passage", content: "" })
      const first = yield* api.SaveSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: made.revision,
        title: "Passage",
        content: "The first good passage, kept from a swipe."
      })
      // Replacing the whole text is destructive, so the text before it has its own entry.
      const replaced = yield* api.SaveSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: first.revision,
        title: "Passage",
        content: "Replaced."
      })
      const history = yield* api.SnippetHistory({ ...scope, refId: made.ref.id, limit: 10 })
      assert.strictEqual(history[0]!.length, "Replaced.".length)
      const earlier = history.find((state) => state.length === first.content.length)
      assert.isDefined(earlier)
      // A stale revision is refused rather than overwriting newer text.
      const stale = yield* outcome(
        api.RestoreSnippet({ ...scope, refId: made.ref.id, expectedRevision: first.revision, seq: earlier!.seq })
      )
      assert.strictEqual(stale, "StaleWrite")
      const restored = yield* api.RestoreSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: replaced.revision,
        seq: earlier!.seq
      })
      assert.strictEqual(restored.content, first.content)
      assert.strictEqual(restored.title, "Passage")
      assert.notStrictEqual(restored.revision, replaced.revision)
      // After a reload (a fresh list), the restored text is the snippet's, and the replaced text
      // stays in the history as a restore.
      const listed = (yield* api.ListSnippets(scope)).find((item) => item.ref.id === made.ref.id)!
      assert.strictEqual(listed.content, first.content)
      const after = yield* api.SnippetHistory({ ...scope, refId: made.ref.id, limit: 10 })
      assert.strictEqual(after[0]!.kind, "restore")
      assert.isTrue(after.some((state) => state.length === "Replaced.".length))
      const global = yield* api.MakeSnippetGlobal({ ...scope, refId: made.ref.id, expectedRevision: restored.revision })
      const outside = { chatId: null, forkId: null, refId: made.ref.id }
      assert.deepStrictEqual(yield* api.SnippetHistory({ ...outside, limit: 10 }), after)
      const globalRestore = yield* api.RestoreSnippet({
        ...outside,
        expectedRevision: global.revision,
        seq: history[0]!.seq
      })
      assert.strictEqual(globalRestore.content, "Replaced.")
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("assembles linked snippets from the viewed fork and rebuilds the pinned text", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const chat = yield* api.CreateChat({ title: "Scoped note assembly" })
      const scope = { chatId: chat.id, forkId: chat.currentForkId }
      const sent = yield* api.SendMessage({ ...scope, parentSlotId: null, branch: false, content: "At the quay." })
      assert.strictEqual(sent._tag, "Posted")
      if (sent._tag !== "Posted") return
      const made = yield* api.CreateSnippet({ ...scope, title: "Weather", content: "SNIPPET_RAIN" })
      const slot = yield* api.CreateChatNote({ ...scope, title: "Weather", link: made.ref.entityId })
      yield* api.ChangeCast({
        ...scope,
        slotId: null,
        change: { _tag: "Note", entityId: slot.entityId, active: true }
      })
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
      const frozen = yield* inspect(scope.forkId)
      const text = (json: string) =>
        (JSON.parse(json) as ContextSnapshot).request.messages.map((message) => message.content).join("\n")
      assert.include(text(frozen.snapshot), "SNIPPET_RAIN")
      yield* api.SaveSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: made.revision,
        title: "Weather",
        content: "SNIPPET_SUNRISE"
      })
      assert.include(text((yield* inspect(scope.forkId)).snapshot), "SNIPPET_SUNRISE")
      const sibling = text((yield* inspect(child.id)).snapshot)
      assert.include(sibling, "SNIPPET_RAIN")
      assert.notInclude(sibling, "SNIPPET_SUNRISE")
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: frozen.snapshot })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.strictEqual(text(rebuilt.snapshot), text(frozen.snapshot))
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("unlinking in a viewed fork copies that fork's snippet text", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Unlink in another fork" })
      const scope = { chatId: chat.id, forkId: chat.currentForkId }
      const made = yield* api.CreateSnippet({ ...scope, title: "Weather", content: "Rain." })
      const slot = yield* api.CreateChatNote({ ...scope, title: "Weather", link: made.ref.entityId })
      const child = (yield* api.CreateFork({ chatId: chat.id, fromForkId: scope.forkId, atSlotId: null })).fork
      yield* api.SaveSnippet({
        ...scope,
        forkId: child.id,
        refId: made.ref.id,
        expectedRevision: made.revision,
        title: "Child weather",
        content: "Snow."
      })
      // Creating a fork makes it current. Unlink the original fork while viewing it instead.
      yield* api.UnlinkNote({ noteRefId: slot.id, chatNote: { ...scope, slotId: null } })
      const original = yield* api.ListChatNotes({ ...scope, slotId: null })
      assert.strictEqual(original[0]!.doc.content, "Rain.")
      assert.isNull(original[0]!.linked)
      const sibling = yield* api.ListChatNotes({ ...scope, forkId: child.id, slotId: null })
      assert.strictEqual(sibling[0]!.doc.content, "Snow.")
      assert.isNotNull(sibling[0]!.linked)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("shares one store, inherits from any fork point, and keeps existing forks independent", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Snippet fixture" })
      const scope = { chatId: chat.id, forkId: chat.currentForkId }
      const earlier = (yield* api.CreateFork({ chatId: chat.id, fromForkId: scope.forkId, atSlotId: null })).fork
      const created = yield* api.CreateSnippet({ ...scope, title: "Harbour", content: "Rain." })
      assert.strictEqual(created.global, false)
      assert.deepStrictEqual(yield* api.ListSnippets({ ...scope, forkId: earlier.id }), [])
      const inherited = (yield* api.CreateFork({ chatId: chat.id, fromForkId: scope.forkId, atSlotId: null })).fork
      const changed = yield* api.SaveSnippet({
        ...scope,
        refId: created.ref.id,
        expectedRevision: created.revision,
        title: "Harbour at dawn",
        content: "Sunrise."
      })
      assert.strictEqual(changed.draft!.content, "Sunrise.")
      assert.strictEqual((yield* api.ListSnippets({ ...scope, forkId: inherited.id }))[0]!.content, "Rain.")
      assert.strictEqual((yield* api.ListSnippets({ ...scope, query: "SUNRISE" }))[0]!.title, "Harbour at dawn")
      assert.strictEqual(
        yield* outcome(
          api.SaveSnippet({
            ...scope,
            refId: created.ref.id,
            expectedRevision: created.revision,
            title: "Stale",
            content: "Must not replace sunrise"
          })
        ),
        "StaleWrite"
      )
      const child = (yield* api.CreateFork({ chatId: chat.id, fromForkId: scope.forkId, atSlotId: null })).fork
      assert.strictEqual((yield* api.ListSnippets({ ...scope, forkId: child.id }))[0]!.content, "Sunrise.")
      const inChild = (yield* api.ListSnippets({ ...scope, forkId: child.id }))[0]!
      yield* api.SaveSnippet({
        ...scope,
        forkId: child.id,
        refId: inChild.ref.id,
        expectedRevision: inChild.revision,
        title: "Child's harbour",
        content: "Snow."
      })
      assert.strictEqual((yield* api.ListSnippets(scope))[0]!.content, "Sunrise.")
      const listed = yield* api.ListSharedNotes({ chatNote: { ...scope, slotId: null } })
      assert.strictEqual(listed[0]!.ref.entityId, created.ref.entityId)
      assert.deepStrictEqual(yield* api.ListSharedNotes({}), [])
      const slot = yield* api.CreateChatNote({ ...scope, title: "Weather", link: created.ref.entityId })
      const notes = yield* api.ListChatNotes({ ...scope, slotId: null })
      assert.strictEqual(notes.find((n) => n.ref.id === slot.id)!.doc.content, "Sunrise.")
      const childNotes = yield* api.ListChatNotes({ ...scope, forkId: child.id, slotId: null })
      assert.strictEqual(childNotes.find((n) => n.ref.id === slot.id)!.doc.content, "Snow.")
      const card = yield* api.CreateCard({ label: "Lighthouse keeper", name: "Keeper" })
      const cardSlot = yield* api.CreateCardNote({
        cardRefId: card.id,
        title: "Weather",
        link: created.ref.entityId,
        chatNote: { ...scope, slotId: null }
      })
      assert.strictEqual((yield* api.OpenEditor({ refId: cardSlot.id })).doc.link, created.ref.entityId)
      const other = yield* api.CreateChat({ title: "Other chat" })
      assert.deepStrictEqual(yield* api.ListSnippets({ chatId: other.id, forkId: null }), [])
      const global = yield* api.MakeSnippetGlobal({
        ...scope,
        refId: changed.ref.id,
        expectedRevision: changed.revision
      })
      assert.strictEqual(global.global, true)
      assert.strictEqual((yield* api.ListSharedNotes({}))[0]!.ref.id, created.ref.id)
      assert.strictEqual((yield* api.ListSnippets({ chatId: other.id, forkId: null }))[0]!.content, "Sunrise.")
      yield* api.DeleteNote({ noteRefId: created.ref.id })
      assert.deepStrictEqual(yield* api.ListSnippets(scope), [])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("opens existing shared notes and creates globals outside chats", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const global = yield* api.CreateSharedNote({ title: "Old shared note", content: "A shared text" })
      const scope = { chatId: null, forkId: null }
      assert.strictEqual((yield* api.ListSnippets(scope))[0]!.ref.id, global.id)
      const made = yield* api.CreateSnippet({ ...scope, title: "New global", content: "Some text" })
      assert.strictEqual(made.global, true)
      assert.strictEqual((yield* api.OpenEditor({ refId: made.ref.id })).doc.content, "Some text")
      const saved = yield* api.SaveSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: made.revision,
        title: "Edited",
        content: "New text"
      })
      assert.isAbove(saved.draft!.historyLength, 0)
      assert.strictEqual((yield* api.OpenEditor({ refId: made.ref.id })).doc.content, "New text")
      const again = yield* api.SaveSnippet({
        ...scope,
        refId: made.ref.id,
        expectedRevision: saved.revision,
        title: "Edited",
        content: "Longer text"
      })
      assert.isAbove(again.draft!.historyLength, 0)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("keeps snippet bindings when fork lineage is compacted", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Long fork lineage" })
      const scope = { chatId: chat.id, forkId: chat.currentForkId }
      const original = yield* api.CreateSnippet({ ...scope, title: "Inherited", content: "Frozen passage" })
      let forkId = scope.forkId
      for (let i = 0; i < 65; i++)
        forkId = (yield* api.CreateFork({ chatId: chat.id, fromForkId: forkId, atSlotId: null })).fork.id
      const [inherited] = yield* api.ListSnippets({ chatId: chat.id, forkId })
      assert.strictEqual(inherited!.content, "Frozen passage")
      yield* api.SaveSnippet({
        chatId: chat.id,
        forkId,
        refId: inherited!.ref.id,
        expectedRevision: inherited!.revision,
        title: "At the cap",
        content: "New passage"
      })
      assert.strictEqual((yield* api.ListSnippets(scope))[0]!.revision, original.revision)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
  it.live("purges snippet drafts with their shared note reference", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const chat = yield* api.CreateChat({ title: "Purged snippet" })
      const made = yield* api.CreateSnippet({
        chatId: chat.id,
        forkId: chat.currentForkId,
        title: "Ephemeral",
        content: "Private synthetic text"
      })
      assert.isTrue((yield* reader.ListActiveDrafts({ userId })).some((draft) => draft.key.targetId === made.ref.id))
      const binned = yield* api.DeleteNote({ noteRefId: made.ref.id })
      yield* api.PurgeBinItem({ itemId: binned.id })
      assert.isFalse((yield* reader.ListActiveDrafts({ userId })).some((draft) => draft.key.targetId === made.ref.id))
      let forkId = chat.currentForkId
      for (let i = 0; i < 65; i++)
        forkId = (yield* api.CreateFork({ chatId: chat.id, fromForkId: forkId, atSlotId: null })).fork.id
      assert.deepStrictEqual(yield* api.ListSnippets({ chatId: chat.id, forkId }), [])
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
