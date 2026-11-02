import { assert, layer } from "@effect/vitest"
import { type ForkId, NewVersion } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const config = testConfig()
const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id as UserId
  const parent = yield* writer.CreateEntity({
    userId,
    kind: "card",
    label: "Pilot",
    subtitle: "",
    doc: cardDoc("Pilot", { description: "Original definition" }),
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "Fork test",
    participants: [parent.entityId],
    greeting: null
  })
  const main = chat.currentForkId as ForkId
  const append = (forkId: ForkId, parentSlotId: typeof chat.activeLeafSlotId, content: string, generating = false) =>
    writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId,
      parentSlotId,
      branch: false,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: parent.entityId,
        writer: "model",
        content,
        status: generating ? "generating" : "complete",
        macroMode: "verbatim",
        origin: "generated"
      })
    })
  const a = yield* append(main, null, "A")
  const b = yield* append(main, a.slotId, "B")
  const c = yield* append(main, b.slotId, "C")
  const d = yield* append(main, c.slotId, "D", true)
  const other = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: d.slotId })).fork.id
  const fork = (version: string) =>
    api.ForkCardForChat({
      chatId: chat.id,
      forkId: main,
      slotId: d.slotId,
      entityId: parent.entityId,
      name: "Pilot",
      nickname: "Captain",
      characterVersion: version
    })
  const cast = (forkId: ForkId, slotId = d.slotId) => api.GetCast({ chatId: chat.id, forkId, slotId })
  return { api, writer, reader, userId, parent, chat, main, other, a, b, c, d, fork, cast, append }
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("fork card for chat", (it) => {
  it.effect(
    "copies the bound revision, note switches and draft choices, moves only this fork's queue, and inherits on earlier branches",
    () =>
      Effect.gen(function* () {
        const t = yield* setup
        const { api, writer, userId, parent, chat, main, other, a, b, c, d } = t
        const note = yield* api.CreateCardNote({ cardRefId: parent.ref.id, title: "Coat" })
        const alternate = yield* writer.AddVersion({
          userId,
          slotId: a.slotId,
          forkId: main,
          select: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: parent.entityId,
            writer: "model",
            content: "Alternate A",
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          forkId: main,
          slotId: a.slotId,
          versionId: alternate.id,
          scope: null,
          data: { key: "note.activate", value: { note: note.entityId } }
        })
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          forkId: main,
          slotId: a.slotId,
          versionId: a.version.id,
          scope: null,
          data: { key: "note.deactivate", value: { note: note.entityId } }
        })
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          forkId: main,
          slotId: c.slotId,
          versionId: null,
          scope: null,
          data: { key: "note.activate", value: { note: note.entityId } }
        })
        yield* writer.AddStateEvent({
          userId,
          chatId: chat.id,
          forkId: main,
          slotId: b.slotId,
          versionId: null,
          scope: null,
          data: { key: "card.binding", value: { entity: parent.entityId, revision: parent.ref.headRevisionId } }
        })
        yield* writer.EditRef({
          userId,
          refId: parent.ref.id,
          expectedRowVersion: parent.ref.rowVersion,
          doc: cardDoc("Pilot", { description: "Latest definition" }),
          message: null,
          commitDraft: null
        })
        const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: main })
        const siblingDraft = yield* api.OpenComposer({ chatId: chat.id, forkId: other })
        for (const composer of [draft, siblingDraft])
          yield* api.SetComposerChoice({
            chatId: chat.id,
            draftId: composer.id,
            speakerEntityId: parent.entityId,
            replyFromEntityId: parent.entityId
          })
        for (const forkId of [main, other])
          yield* writer.SendOrQueue({
            userId,
            chatId: chat.id,
            forkId,
            parentSlotId: d.slotId,
            branch: false,
            kind: "message",
            content: "Queued pilot",
            speakerEntityId: parent.entityId,
            replySpeakerEntityId: parent.entityId,
            direction: null,
            commitDraft: null
          })
        const deleted = yield* writer.DeleteMessage({ userId, slotId: c.slotId, forkId: main })
        const made = yield* t.fork("storm")
        assert.strictEqual((yield* api.OpenEditor({ refId: made.id })).doc.description, "Original definition")
        assert.deepStrictEqual((yield* t.cast(main)).participants, [made.entityId])
        assert.isTrue(
          (yield* t.cast(main)).cards.some((card) => card.entityId === parent.entityId && card.name === "Pilot")
        )
        assert.deepStrictEqual((yield* t.cast(other)).participants, [parent.entityId])
        assert.strictEqual(
          (yield* api.CardFamily({ entityId: made.entityId })).members.find((m) => m.entityId === made.entityId)!
            .forkedInChatId,
          chat.id
        )
        const copy = (yield* api.ListCardNotes({ cardRefId: made.id }))[0]!
        const notesAt = (slotId: typeof a.slotId) => api.ListChatNotes({ chatId: chat.id, forkId: main, slotId })
        assert.isFalse((yield* notesAt(a.slotId)).find((n) => n.ref.entityId === copy.ref.entityId)!.active)
        assert.isFalse((yield* notesAt(d.slotId)).find((n) => n.ref.entityId === copy.ref.entityId)!.active)
        yield* writer.RestoreBinItem({ userId, itemId: deleted.id })
        assert.isTrue((yield* notesAt(c.slotId)).find((n) => n.ref.entityId === copy.ref.entityId)!.active)
        yield* writer.SelectVersion({
          userId,
          slotId: a.slotId,
          forkId: main,
          versionId: alternate.id,
          expectedVersionId: a.version.id
        })
        assert.isTrue((yield* notesAt(a.slotId)).find((n) => n.ref.entityId === copy.ref.entityId)!.active)
        yield* writer.SelectVersion({
          userId,
          slotId: a.slotId,
          forkId: main,
          versionId: a.version.id,
          expectedVersionId: alternate.id
        })
        assert.isFalse((yield* notesAt(a.slotId)).find((n) => n.ref.entityId === copy.ref.entityId)!.active)
        const queued = yield* t.reader.ListQueued({ userId, chatId: chat.id })
        assert.deepStrictEqual(
          queued.map((q) => [q.speakerEntityId, q.replySpeakerEntityId]),
          [
            [made.entityId, made.entityId],
            [parent.entityId, parent.entityId]
          ]
        )
        assert.strictEqual(
          (yield* api.GetComposerChoice({ chatId: chat.id, draftId: draft.id })).speakerEntityId,
          made.entityId
        )
        assert.strictEqual(
          (yield* api.GetComposerChoice({ chatId: chat.id, draftId: draft.id })).replyFromEntityId,
          made.entityId
        )
        assert.strictEqual(
          (yield* api.GetComposerChoice({ chatId: chat.id, draftId: siblingDraft.id })).speakerEntityId,
          parent.entityId
        )
        const child = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: a.slotId })).fork
          .id
        assert.deepStrictEqual((yield* t.cast(child, a.slotId)).participants, [made.entityId])
        yield* api.ChangeCast({
          chatId: chat.id,
          forkId: child,
          slotId: a.slotId,
          change: { _tag: "Swap", entityId: parent.entityId, replaces: made.entityId }
        })
        assert.deepStrictEqual((yield* t.cast(child, a.slotId)).participants, [parent.entityId])
        assert.deepStrictEqual((yield* t.cast(main)).participants, [made.entityId])
        assert.strictEqual(
          (yield* t.reader.GetSlot({ userId, slotId: a.slotId })).entry.version.speakerEntityId,
          parent.entityId
        )
      })
  )

  it.effect("a forced failure after the copies and swap rolls back every row", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const draft = yield* t.api.OpenComposer({ chatId: t.chat.id, forkId: t.main })
      yield* t.api.SetComposerChoice({ chatId: t.chat.id, draftId: draft.id, speakerEntityId: t.parent.entityId })
      yield* t.api.CreateCardNote({ cardRefId: t.parent.ref.id, title: "Rollback note" })
      const count = () =>
        fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT (SELECT count(*) FROM entities) AS entities, (SELECT count(*) FROM entity_revisions) AS revisions, (SELECT count(*) FROM state_events) AS events"
            }
          ],
          { readOnly: true }
        )
      const before = yield* count()
      yield* fixtureSql(config.dataDir, [
        {
          sql: "CREATE TRIGGER fail_chat_fork BEFORE UPDATE OF speaker_entity_id ON drafts BEGIN SELECT RAISE(ABORT, 'forced failure'); END"
        }
      ])
      const result = yield* outcome(t.fork("rollback"))
      assert.strictEqual(result, "ServerError")
      yield* fixtureSql(config.dataDir, [{ sql: "DROP TRIGGER fail_chat_fork" }])
      assert.deepStrictEqual(yield* count(), before)
      assert.deepStrictEqual((yield* t.cast(t.main)).participants, [t.parent.entityId])
      const clash = yield* outcome(t.fork(""))
      assert.strictEqual(clash, "EditRefused")
      assert.deepStrictEqual(yield* count(), before)
    })
  )

  it.effect("forks the visible card after a swapped-in card is purged", () =>
    Effect.gen(function* () {
      const t = yield* setup
      const removed = yield* t.fork("removed")
      const item = yield* t.writer.DeleteEntity({ userId: t.userId, entityId: removed.entityId })
      yield* t.api.PurgeBinItem({ itemId: item.id })
      assert.deepStrictEqual((yield* t.cast(t.main)).participants, [t.parent.entityId])
      const made = yield* t.fork("after purge")
      assert.deepStrictEqual((yield* t.cast(t.main)).participants, [made.entityId])
      assert.deepStrictEqual((yield* t.cast(t.other)).participants, [t.parent.entityId])
    })
  )
})
