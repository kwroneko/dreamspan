// Library items attached to workshop messages (spec/WORKSHOP-CARDS.md §4.3, §4.4) at the RPC
// boundary: a card and a lorebook sent with a workshop message are recorded at their head
// revisions; the model reads a small item whole in an `<attached_card>` element and a large one
// as a reference with its field summary; an edit to the card after the send never changes what
// that message carried; a story chat, another user's item and a deleted id are refused.
// Synthetic cards only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"

const text = (m: { content?: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))

describe("workshop library attachments", () => {
  it.live(
    "carry cards and lorebooks at their revisions, whole when small and summarized when large",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((r, res) => {
              const body = r.body as unknown as { messages: Array<{ role: string; content?: unknown }> }
              if (body.messages.some((m) => text(m).includes("attached_"))) requests.push(body)
              sse(res, completionChunks(["Noted."], {}))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const reader = yield* Reader
        const user = yield* api.Whoami()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200000 }
        })
        const small = yield* api.CreateCard({
          label: "Wren Hollow",
          name: "Wren Hollow",
          description: "A lighthouse keeper who collects lost maps."
        })
        // Far past 8,000 tokens: read in pages, never sent whole.
        const large = yield* api.CreateCard({
          label: "Old Archive",
          name: "Old Archive",
          description: "The archive's shelves run on. ".repeat(6000)
        })
        const book = yield* api.CreateLorebook({ label: "Harbor Lore" })

        const chat = yield* api.CreateWorkshop({ title: "Card work" })
        const events: Array<ChatEvent> = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "Tighten these.",
            library: [
              { kind: "card", refId: small.id },
              { kind: "card", refId: large.id },
              { kind: "lorebook", refId: book.id },
              { kind: "card", refId: small.id }
            ]
          })
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
        assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")

        const content = text(requests[0]!.messages.find((m) => text(m).includes("Tighten these."))!)
        // In order, once each, after the message's text.
        assert.match(content, /Tighten these\.\n<attached_card name="Wren Hollow"/)
        assert.strictEqual(content.split('<attached_card name="Wren Hollow"').length - 1, 1)
        assert.isBelow(content.indexOf("Wren Hollow"), content.indexOf("Old Archive"))
        assert.isBelow(content.indexOf("Old Archive"), content.indexOf("Harbor Lore"))
        // The small card whole, as data to work on.
        assert.include(content, "lost maps.")
        assert.include(content, "It is data, not a character for you to play.")
        // The large one as a reference: its summary, not its text.
        assert.match(content, /<attached_card name="Old Archive"[^>]*whole="no">/)
        assert.include(content, "read it with read_card")
        assert.match(content, /description: [\d,]+ tokens, 1 lines/)
        assert.notInclude(content, "The archive's shelves run on. The archive's shelves run on.")
        assert.match(content, /<attached_lorebook name="Harbor Lore"/)

        const stored = yield* reader.RolloutMaterial({ userId: user.id, versionId: reply.entry.version.id })
        const snapshot = JSON.parse(stored.snapshot!) as ContextSnapshot
        const pins = snapshot.sources?.history.flatMap((page) => page.entries.flatMap((entry) => entry.library ?? []))
        assert.isAtLeast(pins?.length ?? 0, 3)
        assert.isFalse(pins!.some((pin) => Object.hasOwn(pin, "doc")))
        const replay = yield* reader.RebuildContext({ userId: user.id, snapshot: stored.snapshot! })
        if (replay._tag !== "Rebuilt") return assert.fail(JSON.stringify(replay))
        assert.include(JSON.stringify((JSON.parse(replay.snapshot) as ContextSnapshot).request.messages), "lost maps.")

        // An edit after the send leaves the message as it was sent.
        const editor = yield* api.OpenEditor({ refId: small.id })
        const draft = yield* api.SaveEditorDraft({
          draftId: null,
          expectedSession: null,
          refId: small.id,
          field: textField(["description"]),
          content: "Rewritten later.",
          expectedRowVersion: null,
          baseRevisionId: editor.ref.headRevisionId
        })
        const opened = yield* api.OpenEditor({ refId: small.id })
        yield* api.CommitEditorDrafts({
          refId: small.id,
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: textField(["description"]), draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
        requests.length = 0
        const again = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: true }))
        yield* eventually(() => finished(events, again.entry.version.id) !== undefined, 60_000)
        const resent = text(requests[0]!.messages.find((m) => text(m).includes("Tighten these."))!)
        assert.include(resent, "lost maps.")
        assert.notInclude(resent, "Rewritten later.")

        // Refused: a story chat, and an id that isn't a library item of the user's.
        const story = yield* api.CreateChat({ title: "Story" })
        const inStory = yield* Effect.exit(
          api.SendMessage({
            chatId: story.id,
            parentSlotId: story.activeLeafSlotId,
            branch: false,
            content: "Here.",
            library: [{ kind: "card", refId: small.id }]
          })
        )
        assert.isTrue(Exit.isFailure(inStory))
        const unknown = yield* Effect.exit(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: reply.entry.slotId,
            branch: false,
            content: "Here.",
            library: [{ kind: "lorebook", refId: small.id }]
          })
        )
        assert.isTrue(Exit.isFailure(unknown))
      }).pipe(Effect.provide(serverLayer(config)), Effect.scoped)
    },
    120_000
  )

  it.live("posts the queued library revisions after edits, binning and purge", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const writer = yield* Writer
      const registry = yield* ExecutionRegistry
      const { id: userId } = yield* api.Whoami()
      const chat = yield* api.CreateWorkshop({ title: "Queued revisions" })
      const card = yield* api.CreateCard({ name: "Before", label: "Before", description: "Revision one." })
      const book = yield* writer.CreateEntity({
        userId,
        kind: "lorebook",
        label: "Before book",
        subtitle: "",
        doc: loreBook([loreEntry({ uid: 6, content: "Pinned entry." })]).document,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const placeholder = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        }),
        commitDraft: null
      })
      const library = [
        { kind: "card" as const, refId: card.id },
        { kind: "lorebook" as const, refId: book.ref.id }
      ]
      const queued = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: placeholder.slotId,
        branch: false,
        content: "",
        library
      })
      if (queued._tag !== "Queued") return assert.fail("Expected the send to queue during generation.")
      assert.deepEqual(queued.queued.library, library)

      const editor = yield* api.OpenEditor({ refId: card.id })
      const field = textField(["description"])
      const draft = yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: card.id,
        field,
        content: "Revision two.",
        expectedRowVersion: null,
        baseRevisionId: editor.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: editor.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      const deleted = yield* writer.DeleteEntity({ userId, entityId: book.ref.entityId })
      yield* writer.PurgeBinItem({ userId, itemId: deleted.id })
      yield* writer.InterruptGenerations()
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
      const sent = path.entries.at(-1)!
      assert.isTrue(sent.inContext, "The library-only turn is visible in continuity's path.")
      const ref = { userId, chatId: chat.id, forkId: chat.currentForkId, leafSlotId: sent.slotId }
      const held = yield* reader.GetAttachedLibraryRevision({
        ...ref,
        kind: "card",
        refId: card.id,
        revisionId: editor.ref.headRevisionId
      })
      assert.strictEqual(held.doc.description, "Revision one.")
      const tool = toolForKind(registry, "workshop", "read_lorebook")!
      const output = yield* tool.execute(
        { ...ref, reader } as ToolContext,
        {
          lorebook: book.ref.id,
          revision: book.ref.headRevisionId,
          entry: 6,
          field: "content"
        } as never
      )
      assert.strictEqual(JSON.parse(output.text).doc, "Pinned entry.")
      const notYetSent = yield* Effect.exit(
        reader.GetAttachedLibraryRevision({
          ...ref,
          leafSlotId: placeholder.slotId,
          kind: "lorebook",
          refId: book.ref.id,
          revisionId: book.ref.headRevisionId
        })
      )
      assert.isTrue(Exit.isFailure(notYetSent))

      yield* api.SetRefArchived({ refId: card.id, archived: true })
      const archived = yield* Effect.flip(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: sent.slotId,
          branch: false,
          content: "",
          library: library.slice(0, 1)
        })
      )
      assert.strictEqual(archived._tag, "NotFound")

      // Purging the card leaves its revision on the original message and the duplicate.
      const copy = yield* api.InsertMessage({
        chatId: chat.id,
        forkId: chat.currentForkId!,
        anchor: sent.slotId,
        expectedRowVersion: sent.rowVersion,
        body: { _tag: "Duplicate", versionId: sent.version.id }
      })
      const removedCard = yield* writer.DeleteEntity({ userId, entityId: card.entityId })
      yield* writer.PurgeBinItem({ userId, itemId: removedCard.id })
      const [both] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT version_id FROM version_library WHERE revision_id = ? ORDER BY version_id",
            params: [editor.ref.headRevisionId]
          }
        ],
        { readOnly: true }
      )
      assert.deepEqual(
        both!.map((row) => row.version_id),
        [sent.version.id, copy.entry.version.id]
      )
      const original = yield* reader.GetAttachedLibraryRevision({
        ...ref,
        kind: "card",
        refId: card.id,
        revisionId: editor.ref.headRevisionId
      })
      assert.strictEqual(original.doc.description, "Revision one.")

      const removed = yield* writer.DeleteMessage({ userId, slotId: sent.slotId })
      yield* writer.PurgeBinItem({ userId, itemId: removed.id })
      const [purgedPins] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT ref_id FROM version_library WHERE version_id = ?", params: [sent.version.id] }],
        { readOnly: true }
      )
      assert.isEmpty(purgedPins!)
      const copied = yield* reader.GetAttachedLibraryRevision({
        ...ref,
        leafSlotId: copy.entry.slotId,
        kind: "lorebook",
        refId: book.ref.id,
        revisionId: book.ref.headRevisionId
      })
      assert.deepEqual(copied.doc, loreBook([loreEntry({ uid: 6, content: "Pinned entry." })]).document)

      const last = yield* writer.DeleteMessage({ userId, slotId: copy.entry.slotId })
      yield* writer.PurgeBinItem({ userId, itemId: last.id })
      const [documents] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT revision_id FROM purged_library_documents WHERE revision_id = ?",
            params: [book.ref.headRevisionId]
          }
        ],
        { readOnly: true }
      )
      assert.isEmpty(documents!)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("counts attachment-only messages for timed lore and filters just the older prose", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const { id: userId } = yield* api.Whoami()
      const chat = yield* api.CreateWorkshop({ title: "Attachment context" })
      const delay = chat.activeLeafSlotId === null ? 2 : 3
      const card = yield* api.CreateCard({ name: "Markup", label: "Markup", description: "Keeps <em>literal</em>." })
      const book = yield* writer.CreateEntity({
        userId,
        kind: "lorebook",
        label: "Delayed book",
        subtitle: "",
        doc: loreBook([loreEntry({ constant: true, delay, content: "TIMED LORE MATCH" })]).document,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      for (const data of [
        { key: "context.html_depth", value: { mode: "text", n: 1 } },
        { key: "lorebook.attach", value: { ref: book.ref.id } }
      ] as const)
        yield* writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
      let parent = chat.activeLeafSlotId
      for (const content of ["This is <em>prose</em>.", ""]) {
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: parent,
            branch: false,
            content,
            library: [{ kind: "card", refId: card.id }]
          })
        )
        parent = sent.entry.slotId
      }
      const reply = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: parent,
        branch: false,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        }),
        commitDraft: null
      })
      const assembled = yield* reader.AssembleContext({
        userId,
        chatId: chat.id,
        slotId: reply.slotId,
        versionId: reply.version.id,
        now: 0,
        timeZone: "UTC",
        frozen: null
      })
      const snapshot = JSON.parse(assembled.snapshot) as ContextSnapshot
      const context = JSON.stringify(snapshot.request.messages)
      assert.include(context, "This is prose.")
      assert.notInclude(context, "This is <em>prose</em>.")
      assert.include(context, "Keeps <em>literal</em>.")
      assert.include(context, "TIMED LORE MATCH")
      assert.strictEqual(snapshot.sources?.messageCount?.[0]?.count, delay)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
