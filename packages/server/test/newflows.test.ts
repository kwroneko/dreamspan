import { assert, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { textField, validateDoc } from "@dreamspan/shared/editing.ts"
import { DisplayPrefsChange, DEFAULT_DISPLAY_PREFS } from "@dreamspan/shared/chatApi.ts"
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

it.live("each switcher's sort follows the account without overwriting the others", () =>
  Effect.gen(function* () {
    const alice = yield* client({ "Remote-User": "alice" })
    const phone = yield* client({ "Remote-User": "alice" })
    const bob = yield* client({ "Remote-User": "bob" })
    yield* alice.SetDisplayPrefs({ prefs: { lorebookSort: "modified" } })
    yield* phone.SetDisplayPrefs({ prefs: { noteSort: "modified" } })
    yield* alice.SetDisplayPrefs({ prefs: { cardSwitcher: { sort: "name", reversed: false, withPersonas: false } } })
    const reconnect = yield* client({ "Remote-User": "alice" })
    const prefs = yield* reconnect.GetDisplayPrefs({})
    assert.strictEqual(prefs.cardSwitcher.sort, "name")
    assert.strictEqual(prefs.lorebookSort, "modified")
    assert.strictEqual(prefs.noteSort, "modified")
    assert.deepStrictEqual(yield* bob.GetDisplayPrefs({}), DEFAULT_DISPLAY_PREFS)
    const decode = Schema.decodeUnknownOption(DisplayPrefsChange)
    assert.strictEqual(decode({ cardSwitcher: { sort: "invalid", reversed: false, withPersonas: false } })._tag, "None")
    // A list's view (its sort in a grid) is a browser tab's URL now, never the account's.
    assert.strictEqual("homeCards" in prefs, false)
  }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
)
