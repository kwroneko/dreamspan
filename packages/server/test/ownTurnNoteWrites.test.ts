import { assert, layer } from "@effect/vitest"
import { readNoteCondition } from "@rp/shared/docs/note.ts"
import { Effect } from "effect"
import { Writer, Reader } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

layer(serverLayer(testConfig()))("moving card text to notes", (it) => {
  it.effect("makes the pair atomically, keeps the stored original and rejects stale selections", () =>
    Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer,
        reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const original = "Mira wears blue. She fears the sea."
      const card = (yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: { ...cardDoc("Mira"), description: original },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })).ref
      const args = {
        cardRefId: card.id,
        expectedRevisionId: card.headRevisionId,
        field: "description" as const,
        text: original,
        at: 17,
        length: 18
      }
      yield* api.MoveToOwnTurnNote(args)
      const notes = yield* api.ListCardNotes({ cardRefId: card.id })
      assert.strictEqual(notes.length, 2)
      const own = notes.find((n) => readNoteCondition(n.doc.condition).when === "own_turn")!
      const replacement = notes.find((n) => n.doc.replaces !== undefined)!
      assert.strictEqual(
        own.doc.content,
        "[Background on {{char}}, as the story began. Where the story since then shows {{char}} differently, the story wins.]\n\nShe fears the sea."
      )
      assert.deepStrictEqual(own.doc.placement, { mode: "section", section: "own_turn", role: "system" })
      assert.strictEqual(replacement.doc.content, "Mira wears blue. ")
      assert.deepStrictEqual(replacement.doc.replaces, { kind: "card_field", field: "description" })
      assert.strictEqual(own.doc.move_group, replacement.doc.move_group)
      assert.strictEqual(
        (yield* reader.GetRevisionDoc({ userId, refId: card.id, revisionId: card.headRevisionId })).description,
        original
      )
      assert.notStrictEqual(yield* outcome(api.MoveToOwnTurnNote({ ...args, text: "wrong" })), "ok")
      assert.strictEqual((yield* api.ListCardNotes({ cardRefId: card.id })).length, 2)
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Pairs",
        participants: [card.entityId],
        greeting: null
      })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Note", entityId: own.ref.entityId, active: false }
      })
      const switched = yield* api.ListChatNotes({ chatId: chat.id, slotId: null })
      assert.strictEqual(switched.length, 2)
      assert.isTrue(switched.every((n) => !n.active))
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Note", entityId: replacement.ref.entityId, active: true }
      })
      assert.isTrue((yield* api.ListChatNotes({ chatId: chat.id, slotId: null })).every((n) => n.active))
      yield* api.MoveToOwnTurnNote({ ...args, text: "Mira wears blue. ", at: 11, length: 4 })
      const three = yield* api.ListCardNotes({ cardRefId: card.id })
      assert.strictEqual(three.length, 3)
      assert.strictEqual(three.filter((n) => n.doc.replaces !== undefined).length, 1)
      assert.strictEqual(new Set(three.map((n) => n.doc.title)).size, 3)
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Note", entityId: own.ref.entityId, active: false }
      })
      assert.isTrue((yield* api.ListChatNotes({ chatId: chat.id, slotId: null })).every((n) => !n.active))
      const forked = yield* api.ForkCard({ refId: card.id, name: "Mira fork", nickname: "", characterVersion: "" })
      const copied = yield* api.ListCardNotes({ cardRefId: forked.id })
      assert.strictEqual(copied.length, 3)
      assert.isTrue(copied.every((n) => (n.doc.owner as { card: string }).card === forked.entityId))
      assert.strictEqual(copied.filter((n) => readNoteCondition(n.doc.condition).when === "own_turn").length, 2)
      assert.isTrue(copied.every((n) => n.doc.move_group === own.doc.move_group))
    })
  )
})
