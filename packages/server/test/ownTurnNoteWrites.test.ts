import { assert, layer } from "@effect/vitest"
import { readNoteCondition } from "@dreamspan/shared/docs/note.ts"
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
      assert.strictEqual(replacement.doc.content, "Mira wears blue.")
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
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Note", entityId: own.ref.entityId, active: false }
      })
      yield* api.MoveToOwnTurnNote({ ...args, text: "Mira wears blue.", at: 11, length: 4 })
      assert.isTrue(
        (yield* api.ListChatNotes({ chatId: chat.id, slotId: null })).every((n) => !n.active),
        "new moves inherit the group’s existing chat switch"
      )

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

layer(serverLayer(testConfig()))("own-turn move review", (it) => {
  it.effect("rejects cut macros and HTML tags without writing either note", () =>
    Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      for (const [text, at, length] of [
        ["Hello {{char}}.", 8, 3],
        ['<span title="secret">Blue.</span>', 6, 5],
        ["<b>Blue.</b><i>Green.</i>", 3, 11]
      ] as const) {
        const card = (yield* writer.CreateEntity({
          userId,
          kind: "card",
          label: "Mira",
          subtitle: "",
          doc: cardDoc("Mira", { description: text }),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })).ref
        assert.notStrictEqual(
          yield* outcome(
            api.MoveToOwnTurnNote({
              cardRefId: card.id,
              expectedRevisionId: card.headRevisionId,
              field: "description",
              text,
              at,
              length
            })
          ),
          "ok"
        )
        assert.strictEqual((yield* api.ListCardNotes({ cardRefId: card.id })).length, 0)
      }
    })
  )
  it.effect("records an atomic undo in library History and preserves edited notes on a conflict", () =>
    Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const text = "Blue.\n\nInner {{char}} life."
      const card = (yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: cardDoc("Mira", { description: text }),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })).ref
      const moved = yield* api.MoveToOwnTurnNote({
        cardRefId: card.id,
        expectedRevisionId: card.headRevisionId,
        field: "description",
        text,
        at: 7,
        length: text.length - 7
      })
      const history = yield* api.ListLibraryEdits()
      assert.strictEqual(history[0]!.id, moved.editId)
      assert.strictEqual(history[0]!.entries, 2)
      assert.strictEqual((yield* api.UndoLibraryEdit({ editId: moved.editId })).undone, 2)
      const after = yield* api.ListCardNotes({ cardRefId: card.id })
      assert.isTrue(after.every((n) => !n.doc.on_by_default))
      assert.strictEqual(after.find((n) => n.doc.replaces)?.doc.content, text)
      const again = yield* api.MoveToOwnTurnNote({
        cardRefId: card.id,
        expectedRevisionId: card.headRevisionId,
        field: "description",
        text,
        at: 7,
        length: text.length - 7
      })
      assert.isTrue(
        (yield* api.ListCardNotes({ cardRefId: card.id })).find((n) => n.doc.replaces)!.doc.on_by_default === true,
        "moving again after Undo reactivates the shared replacement"
      )
      const fresh = again.notes[0]!
      const doc = (yield* api.OpenEditor({ refId: fresh.id })).doc
      yield* writer.EditRef({
        userId,
        refId: fresh.id,
        expectedRowVersion: fresh.rowVersion,
        doc: { ...doc, content: "Later inner life." },
        message: null,
        commitDraft: null
      })
      const refused = yield* api.UndoLibraryEdit({ editId: again.editId })
      assert.strictEqual(refused.undone, 0)
      assert.strictEqual(
        (yield* api.ListCardNotes({ cardRefId: card.id })).find((n) => n.doc.replaces)?.doc.content,
        "Blue."
      )
      const shared = (yield* api.ListCardNotes({ cardRefId: card.id })).find((n) => n.doc.replaces)!
      yield* writer.EditRef({
        userId,
        refId: shared.ref.id,
        expectedRowVersion: shared.ref.rowVersion,
        doc: { ...shared.doc, on_by_default: false },
        message: null,
        commitDraft: null
      })
      assert.notStrictEqual(
        yield* outcome(
          api.MoveToOwnTurnNote({
            cardRefId: card.id,
            expectedRevisionId: card.headRevisionId,
            field: "description",
            text: "Blue.\n\n",
            at: 0,
            length: 5
          })
        ),
        "ok",
        "a deliberately disabled group needs to be turned on before another move"
      )
      assert.strictEqual((yield* api.ListCardNotes({ cardRefId: card.id })).length, 3)
    })
  )
})

layer(serverLayer(testConfig()))("linked move source review", (it) => {
  it.effect("refuses a linked shared replacement rather than changing text it does not send", () =>
    Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const text = "Blue. Inner life."
      const card = (yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: cardDoc("Mira", { description: text }),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })).ref
      const moved = yield* api.MoveToOwnTurnNote({
        cardRefId: card.id,
        expectedRevisionId: card.headRevisionId,
        field: "description",
        text,
        at: 6,
        length: 11
      })
      yield* api.CreateSharedNote({ title: "Shared description", content: "", fromNoteRefId: moved.notes[1]!.id })
      assert.notStrictEqual(
        yield* outcome(
          api.MoveToOwnTurnNote({
            cardRefId: card.id,
            expectedRevisionId: card.headRevisionId,
            field: "description",
            text: "Blue. ",
            at: 0,
            length: 5
          })
        ),
        "ok"
      )
      assert.strictEqual((yield* api.ListCardNotes({ cardRefId: card.id })).length, 2)
    })
  )
})
