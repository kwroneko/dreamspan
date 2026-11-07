import { assert, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { textField, validateDoc } from "@rp/shared/editing.ts"
import { DisplayPrefsChange, DEFAULT_DISPLAY_PREFS } from "@rp/shared/chatApi.ts"
import { client, testConfig, withServer } from "./support/config.ts"

it.live("creates empty editable lorebooks, independent library notes and persona cards for their owner", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    const book = yield* alice.CreateLorebook({ label: "Synthetic harbor" })
    const opened = yield* alice.OpenEditor({ refId: book.id })
    assert.strictEqual(opened.doc["name"], "Synthetic harbor")
    assert.deepStrictEqual(opened.doc["entries"], [])
    assert.strictEqual(validateDoc("lorebook", opened.doc).ok, true)
    const note = yield* alice.CreateSharedNote({ title: "Synthetic rules", content: "" })
    const noteDoc = (yield* alice.OpenEditor({ refId: note.id })).doc
    assert.deepStrictEqual(noteDoc["owner"], { shared: "global" })
    assert.strictEqual(noteDoc["content"], "")
    const persona = yield* alice.CreateCard({
      label: "Synthetic Wren",
      name: "Synthetic Wren",
      persona: true,
      description: "A lighthouse keeper."
    })
    const ordinary = yield* alice.CreateCard({ label: "Synthetic Moss", name: "Synthetic Moss" })
    const cards = yield* alice.ListCards()
    assert.strictEqual(cards.find((card) => card.entityId === persona.entityId)?.persona, true)
    assert.strictEqual(cards.find((card) => card.entityId === ordinary.entityId)?.persona, false)
    assert.strictEqual((yield* alice.OpenEditor({ refId: persona.id })).doc["description"], "A lighthouse keeper.")
    assert.strictEqual(
      (yield* alice.ListLibrary({ kind: "lorebook" })).some((ref) => ref.id === book.id),
      true
    )
    for (const ref of [book, note, persona]) {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(bob.OpenEditor({ refId: ref.id }))))
      const snapshot = yield* alice.OpenEditor({ refId: ref.id })
      const field = textField([ref.kind === "card" ? "description" : ref.kind === "note" ? "content" : "description"])
      const draft = yield* alice.SaveEditorDraft({
        refId: ref.id,
        field,
        content: "Synthetic edit",
        draftId: null,
        expectedSession: null,
        expectedRowVersion: null,
        baseRevisionId: snapshot.ref.headRevisionId
      })
      yield* alice.CommitEditorDrafts({
        refId: ref.id,
        expectedRowVersion: snapshot.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      assert.strictEqual(
        (yield* alice.OpenEditor({ refId: ref.id })).doc[ref.kind === "note" ? "content" : "description"],
        "Synthetic edit"
      )
    }
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)

it.live("each card list's sort follows the account without overwriting the other lists or switchers", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const phone = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    yield* alice.SetDisplayPrefs({ prefs: { homeCards: { sort: "name", reversed: true, withPersonas: true } } })
    yield* phone.SetDisplayPrefs({ prefs: { sidebarCards: { sort: "added", reversed: false, withPersonas: false } } })
    yield* alice.SetDisplayPrefs({
      prefs: {
        castCards: { sort: "created", reversed: true, withPersonas: false },
        lorebookSort: "modified",
        noteSort: "modified",
        cardSwitcher: { sort: "name", reversed: false, withPersonas: false }
      }
    })
    const reconnect = yield* client({ "Remote-User": "alice" })
    const prefs = yield* reconnect.GetDisplayPrefs({})
    assert.deepStrictEqual(prefs.homeCards, { sort: "name", reversed: true, withPersonas: true })
    assert.strictEqual(prefs.sidebarCards.sort, "added")
    assert.strictEqual(prefs.castCards.sort, "created")
    assert.strictEqual(prefs.castCards.reversed, true)
    assert.strictEqual(prefs.cardSwitcher.sort, "name")
    assert.strictEqual(prefs.lorebookSort, "modified")
    assert.strictEqual(prefs.noteSort, "modified")
    assert.deepStrictEqual(yield* bob.GetDisplayPrefs({}), DEFAULT_DISPLAY_PREFS)
    const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
    assert.strictEqual(decode({ homeCards: { sort: "invalid", reversed: false, withPersonas: false } })._tag, "None")
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)
