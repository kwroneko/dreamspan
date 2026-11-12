// Search and replace across the library (db/libraryReplace.ts, db/libraryReplaceWrites.ts): it
// finds text in every kind with counts per kind, as each editor shows it (unsaved changes
// included); a replace changes only the entries and fields left ticked, as one undoable replace
// that writes a revision per entry; an entry changed since its preview is left alone; undo
// keeps an entry changed since.
import { assert, describe, it } from "@effect/vitest"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { LibraryPreview, LibrarySearch } from "@rp/shared/libraryReplace.ts"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"

const search = (find: string, replace: string, options: Partial<LibrarySearch> = {}): LibrarySearch => ({
  find,
  replace,
  matchCase: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  kinds: ["card", "lorebook", "preset", "note"],
  ...options
})

const setup = Effect.gen(function* () {
  const api = yield* client()
  const mira = yield* api.CreateCard({
    label: "Mira",
    name: "Mira",
    description: "{{char}} keeps the lighthouse. {{char}} waves."
  })
  const odo = yield* api.CreateCard({ label: "Odo", name: "Odo", description: "{{char}} sails at dawn." })
  const note = yield* api.CreateSharedNote({ title: "Harbour", content: "Ask {{char}} about the tide." })
  const book = yield* api.CreateLorebook({ label: "Lighthouse lore" })
  const text = (refId: RefId, path: ReadonlyArray<string>) =>
    Effect.map(api.OpenEditor({ refId }), (opened) =>
      path.reduce((at: unknown, key) => (at as Record<string, unknown>)[key], opened.doc)
    )
  const entry = (preview: LibraryPreview, refId: RefId) => preview.entries.find((e) => e.refId === refId)
  const all = (preview: LibraryPreview) =>
    preview.entries
      .filter((e) => e.blocked === null)
      .map((e) => ({ refId: e.refId, stamp: e.stamp, fields: e.fields.map((f) => f.field) }))
  return { api, mira: mira.id, odo: odo.id, note: note.id, book: book.id, text, entry, all }
})

describe("library search and replace", () => {
  it.effect("finds text in every kind, with counts per kind and the match in its context", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const preview = yield* f.api.PreviewLibraryReplace({ search: search("{{char}}", "{{user}}") })
      const mira = f.entry(preview, f.mira)!
      assert.strictEqual(mira.count, 2)
      assert.strictEqual(mira.kind, "card")
      const description = mira.fields.find((x) => x.field === textField(["description"]))!
      assert.strictEqual(description.label, "Description")
      assert.strictEqual(description.count, 2)
      const { excerpt } = description
      assert.strictEqual(excerpt.text.slice(excerpt.at, excerpt.at + excerpt.length), "{{char}}")
      assert.strictEqual(excerpt.replacement, "{{user}}")
      assert.isDefined(f.entry(preview, f.note))
      const cards = preview.counts.find((c) => c.kind === "card")!
      assert.isAtLeast(cards.entries, 2)
      assert.isAtLeast(cards.matches, 3)
      assert.strictEqual(preview.counts.find((c) => c.kind === "note")!.matches, 1)
      // A kind left out isn't searched; a name is a field like the others.
      const notes = yield* f.api.PreviewLibraryReplace({ search: search("{{char}}", "", { kinds: ["note"] }) })
      assert.deepStrictEqual(
        notes.entries.map((e) => e.refId),
        [f.note]
      )
      const named = yield* f.api.PreviewLibraryReplace({ search: search("lighthouse", "beacon", { wholeWord: true }) })
      assert.isDefined(f.entry(named, f.book))
      assert.strictEqual(f.entry(named, f.mira)!.count, 1)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("replaces only what's ticked, as one undoable replace with a revision per entry", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const asked = search("{{char}}", "Mira")
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      // Odo is left out.
      const choices = f.all(preview).filter((c) => c.refId !== f.odo)
      const result = yield* f.api.ApplyLibraryReplace({ search: asked, choices })
      assert.isNotNull(result.editId)
      assert.strictEqual(result.entries, choices.length)
      assert.deepStrictEqual(result.skipped, [])
      assert.strictEqual(yield* f.text(f.mira, ["description"]), "Mira keeps the lighthouse. Mira waves.")
      assert.strictEqual(yield* f.text(f.note, ["content"]), "Ask Mira about the tide.")
      assert.strictEqual(yield* f.text(f.odo, ["description"]), "{{char}} sails at dawn.")
      const revisions = yield* f.api.ListRevisions({ refId: f.mira, limit: 5 })
      assert.strictEqual(revisions[0]!.origin, "changeset")
      assert.strictEqual(revisions[0]!.message, "Replaced “{{char}}” with “Mira” across the library")
      const edits = yield* f.api.ListLibraryEdits()
      assert.strictEqual(edits[0]!.id, result.editId)
      assert.strictEqual(edits[0]!.entries, choices.length)
      assert.strictEqual(edits[0]!.matches, result.matches)

      // Undo takes it back everywhere nothing changed since; the note changed since keeps its change.
      const note = yield* f.api.OpenEditor({ refId: f.note })
      yield* f.api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: f.note,
        field: textField(["content"]),
        content: "Ask Mira about the tide, twice.",
        expectedRowVersion: null,
        baseRevisionId: note.ref.headRevisionId
      })
      const drafted = yield* f.api.OpenEditor({ refId: f.note })
      yield* f.api.CommitEditorDrafts({
        refId: f.note,
        expectedRowVersion: drafted.ref.rowVersion,
        fields: drafted.drafts
          .filter((d) => d.status === "active")
          .map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
        message: null
      })
      const undone = yield* f.api.UndoLibraryEdit({ editId: result.editId! })
      assert.strictEqual(undone.undone, choices.length - 1)
      assert.deepStrictEqual(
        undone.kept.map((k) => k.refId),
        [f.note]
      )
      assert.strictEqual(yield* f.text(f.mira, ["description"]), "{{char}} keeps the lighthouse. {{char}} waves.")
      assert.strictEqual(yield* f.text(f.note, ["content"]), "Ask Mira about the tide, twice.")
      assert.strictEqual((yield* f.api.ListLibraryEdits())[0]!.undone, choices.length - 1)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("leaves out a field that isn't ticked", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const asked = search("lighthouse", "beacon")
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      const book = f.entry(preview, f.book)!
      const name = textField(["name"])
      assert.isTrue(book.fields.some((x) => x.field === name))
      const mira = f.entry(preview, f.mira)!
      yield* f.api.ApplyLibraryReplace({
        search: asked,
        choices: [{ refId: mira.refId, stamp: mira.stamp, fields: mira.fields.map((x) => x.field) }]
      })
      assert.strictEqual(yield* f.text(f.book, ["name"]), "Lighthouse lore")
      assert.strictEqual(yield* f.text(f.mira, ["description"]), "{{char}} keeps the beacon. {{char}} waves.")
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("goes through unsaved changes, saving them first as their own revision", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const opened = yield* f.api.OpenEditor({ refId: f.odo })
      yield* f.api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: f.odo,
        field: textField(["scenario"]),
        content: "A storm; {{char}} stays ashore.",
        expectedRowVersion: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      const asked = search("ashore", "at sea", { kinds: ["card"] })
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      const odo = f.entry(preview, f.odo)!
      assert.isTrue(odo.unsaved)
      assert.isNull(odo.blocked)
      const result = yield* f.api.ApplyLibraryReplace({ search: asked, choices: f.all(preview) })
      assert.strictEqual(result.entries, 1)
      const after = yield* f.api.OpenEditor({ refId: f.odo })
      assert.strictEqual(after.doc.scenario, "A storm; {{char}} stays at sea.")
      assert.isFalse(after.drafts.some((d) => d.status === "active"))
      const revisions = yield* f.api.ListRevisions({ refId: f.odo, limit: 5 })
      assert.deepStrictEqual(
        revisions.slice(0, 2).map((r) => r.origin),
        ["changeset", "user"]
      )
      // Undone, the unsaved text stays, now saved.
      yield* f.api.UndoLibraryEdit({ editId: result.editId! })
      assert.strictEqual(yield* f.text(f.odo, ["scenario"]), "A storm; {{char}} stays ashore.")
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("leaves an entry changed since its preview as it is", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const asked = search("dawn", "dusk", { kinds: ["card"] })
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      const opened = yield* f.api.OpenEditor({ refId: f.odo })
      yield* f.api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: f.odo,
        field: textField(["personality"]),
        content: "Calm.",
        expectedRowVersion: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      const result = yield* f.api.ApplyLibraryReplace({ search: asked, choices: f.all(preview) })
      assert.strictEqual(result.entries, 0)
      assert.isNull(result.editId)
      assert.strictEqual(result.skipped[0]!.refId, f.odo)
      assert.strictEqual(yield* f.text(f.odo, ["description"]), "{{char}} sails at dawn.")
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("replaces with a regular expression's groups, and says why a bad one can't run", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const asked = search("(\\w+) at (dawn)", "$2: $1", { regex: true, kinds: ["card"] })
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      yield* f.api.ApplyLibraryReplace({ search: asked, choices: f.all(preview) })
      assert.strictEqual(yield* f.text(f.odo, ["description"]), "{{char}} dawn: sails.")
      const bad = yield* Effect.flip(f.api.PreviewLibraryReplace({ search: search("(", "", { regex: true }) }))
      assert.strictEqual(bad._tag, "LibraryReplaceRejected")
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})
