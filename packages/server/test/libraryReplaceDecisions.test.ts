// Two owner decisions on the library-wide search and replace (2026-11-13; ARCHITECTURE §14.6):
// an entry with unsaved changes is skipped and the result says so ("skip and tell"), and the
// user's own replace keeps an approved regex script approved. Unsaved changes are the active
// drafts the server keeps for an entry's fields, one set per entry and user whichever tab typed
// them, so a second tab's editor sees the same ones. Synthetic documents only.
import { assert, describe, it } from "@effect/vitest"
import { textField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { LIBRARY_UNSAVED_REASON, type LibraryPreview, type LibrarySearch } from "@dreamspan/shared/libraryReplace.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

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

const script = {
  id: "script",
  name: "lighthouse",
  find_regex: "/x/g",
  replace_string: "lighthouse light",
  placement: [2],
  disabled: false,
  markdown_only: false,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none",
  min_depth: null,
  max_depth: null,
  trim_strings: []
}

const entries = (preview: LibraryPreview) =>
  preview.entries.map((e) => ({ refId: e.refId, stamp: e.stamp, fields: e.fields.map((f) => f.field) }))

describe("library replace skips entries with unsaved changes", () => {
  it.effect(
    "skips a card, a preset and a lorebook entry with unsaved changes, says why, and leaves them as they are",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const writer = yield* Writer
        const userId = (yield* api.Whoami()).id
        const make = (kind: "card" | "preset" | "lorebook", label: string, doc: object) =>
          writer
            .CreateEntity({
              userId,
              kind,
              label,
              subtitle: "",
              doc: doc as never,
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            })
            .pipe(Effect.map((made) => made.ref.id as RefId))
        const card = yield* make(
          "card",
          "Open card",
          cardDoc("Open card", { description: "{{char}} keeps the light." })
        )
        const preset = yield* make(
          "preset",
          "Open preset",
          presetDoc([{ identifier: "main", content: "Write as {{char}}." }])
        )
        const book = yield* make(
          "lorebook",
          "Open book",
          loreBook([loreEntry({ keys: ["tide"], content: "{{char}} knows the tide." }, 0)], {}, "Open book").document
        )
        const plain = yield* make("card", "Plain card", cardDoc("Plain card", { description: "{{char}} sails." }))

        const asked = search("{{char}}", "Mira")
        const first = yield* api.PreviewLibraryReplace({ search: asked })
        assert.lengthOf(first.entries, 4)
        assert.isTrue(first.entries.every((e) => !e.unsaved && e.blocked === null))
        // Unsaved text in each open entry, typed into a field the search matches.
        const draftIn = (refId: RefId, field: string, content: string) =>
          Effect.gen(function* () {
            const opened = yield* api.OpenEditor({ refId })
            yield* api.SaveEditorDraft({
              draftId: null,
              expectedSession: null,
              refId,
              field,
              content,
              expectedRowVersion: null,
              baseRevisionId: opened.ref.headRevisionId
            })
          })
        const fieldOf = (preview: LibraryPreview, refId: RefId) =>
          preview.entries.find((e) => e.refId === refId)!.fields[0]!.field
        yield* draftIn(card, textField(["description"]), "{{char}} keeps the light, unsaved.")
        yield* draftIn(preset, fieldOf(first, preset), "Write as {{char}}, unsaved.")
        yield* draftIn(book, fieldOf(first, book), "{{char}} knows the tide, unsaved.")

        // Their unsaved text is still searched and listed, marked, and not replaceable.
        const preview = yield* api.PreviewLibraryReplace({ search: asked })
        for (const refId of [card, preset, book]) {
          const hit = preview.entries.find((e) => e.refId === refId)!
          assert.isTrue(hit.unsaved, hit.label)
          assert.strictEqual(hit.blocked, LIBRARY_UNSAVED_REASON)
        }
        assert.isFalse(preview.entries.find((e) => e.refId === plain)!.unsaved)

        // Sent with the rest, as the panel sends them: replaced where it can be, skipped and told where not.
        const result = yield* api.ApplyLibraryReplace({ search: asked, choices: entries(preview) })
        assert.strictEqual(result.entries, 1)
        assert.deepStrictEqual(
          result.skipped.map((s) => [s.refId, s.label, s.reason]).sort(),
          [
            [card, "Open card", LIBRARY_UNSAVED_REASON],
            [preset, "Open preset", LIBRARY_UNSAVED_REASON],
            [book, "Open book", LIBRARY_UNSAVED_REASON]
          ].sort()
        )
        assert.strictEqual((yield* api.OpenEditor({ refId: plain })).doc.description, "Mira sails.")
        for (const refId of [card, preset, book]) {
          const before = first.entries.find((e) => e.refId === refId)!
          const after = yield* api.OpenEditor({ refId })
          assert.notInclude(JSON.stringify(after.doc), "Mira", before.label)
          // The draft is untouched, in this tab's editor and in a second tab's: one set of drafts per entry.
          const second = yield* api.OpenEditor({ refId })
          assert.isTrue(
            second.drafts.some((d) => d.status === "active" && d.content.includes("unsaved")),
            before.label
          )
          assert.isTrue(
            after.drafts.some((d) => d.status === "active" && d.content.includes("unsaved")),
            before.label
          )
        }
        assert.lengthOf(yield* api.ListLibraryEdits(), 1)
      }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("skips an entry that got unsaved changes after the search, and one saved clean is replaced again", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Odo", name: "Odo", description: "{{char}} sails at dawn." })
      const asked = search("dawn", "dusk", { kinds: ["card"] })
      const preview = yield* api.PreviewLibraryReplace({ search: asked })
      const flagged = yield* api.ApplyLibraryReplace({
        search: asked,
        choices: entries(preview).map((choice) => ({ ...choice, unsaved: true }))
      })
      assert.strictEqual(flagged.entries, 0)
      assert.strictEqual(flagged.skipped[0]!.reason, LIBRARY_UNSAVED_REASON)
      const opened = yield* api.OpenEditor({ refId: card.id })
      yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: card.id,
        field: textField(["description"]),
        content: "{{char}} sails at dawn, typing.",
        expectedRowVersion: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      const late = yield* api.ApplyLibraryReplace({ search: asked, choices: entries(preview) })
      assert.strictEqual(late.entries, 0)
      assert.lengthOf(late.skipped, 1)
      assert.strictEqual(late.skipped[0]!.label, "Odo")
      assert.strictEqual((yield* api.OpenEditor({ refId: card.id })).ref.headRevisionId, opened.ref.headRevisionId)
      // Saved, it has no unsaved changes and the replace goes through.
      const drafted = yield* api.OpenEditor({ refId: card.id })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: drafted.ref.rowVersion,
        fields: drafted.drafts
          .filter((d) => d.status === "active")
          .map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
        message: null
      })
      const again = yield* api.PreviewLibraryReplace({ search: asked })
      assert.isFalse(again.entries[0]!.unsaved)
      const done = yield* api.ApplyLibraryReplace({ search: asked, choices: entries(again) })
      assert.strictEqual(done.entries, 1)
      assert.strictEqual((yield* api.OpenEditor({ refId: card.id })).doc.description, "{{char}} sails at dusk, typing.")
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})

describe("library replace and regex approval", () => {
  const withScripts = (approved: boolean) =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const make = (kind: "card" | "preset", doc: object) =>
        writer
          .CreateEntity({
            userId,
            kind,
            label: kind,
            subtitle: "",
            doc: { ...doc, regex: [script], regex_approved: approved } as never,
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
          .pipe(Effect.map((made) => made.ref.id as RefId))
      return {
        api,
        card: yield* make("card", cardDoc("Scripted", { description: "Plain." })),
        preset: yield* make("preset", presetDoc())
      }
    })

  it.effect("keeps an approved script approved when the user's own replace changes it", () =>
    Effect.gen(function* () {
      const f = yield* withScripts(true)
      const asked = search("lighthouse", "beacon", { kinds: ["card", "preset"] })
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      assert.sameMembers(
        preview.entries.map((e) => e.refId),
        [f.card, f.preset]
      )
      const result = yield* f.api.ApplyLibraryReplace({ search: asked, choices: entries(preview) })
      assert.strictEqual(result.entries, 2)
      assert.sameDeepMembers(
        [...result.approvedScripts],
        [
          { refId: f.card, label: "Scripted", name: "beacon" },
          { refId: f.preset, label: "preset", name: "beacon" }
        ]
      )
      for (const refId of [f.card, f.preset]) {
        const doc = (yield* f.api.OpenEditor({ refId })).doc
        const changed = (doc.regex as Array<typeof script>)[0]!
        assert.strictEqual(changed.name, "beacon")
        assert.strictEqual(changed.replace_string, "beacon light")
        assert.isTrue(doc.regex_approved, `${refId}: still approved`)
      }
      // Undo restores exactly the approval the user had before their own replace.
      yield* f.api.UndoLibraryEdit({ editId: result.editId! })
      for (const refId of [f.card, f.preset])
        assert.isTrue((yield* f.api.OpenEditor({ refId })).doc.regex_approved, `${refId}: prior approval restored`)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("keeps approval for the user's own material pattern and flag replacement, and reports it", () =>
    Effect.gen(function* () {
      const f = yield* withScripts(true)
      const asked = search("/x/g", "/(a+)+$/gi", { kinds: ["card", "preset"] })
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      const result = yield* f.api.ApplyLibraryReplace({ search: asked, choices: entries(preview) })
      assert.strictEqual(result.entries, 2)
      assert.lengthOf(result.approvedScripts, 2)
      for (const refId of [f.card, f.preset]) {
        const doc = (yield* f.api.OpenEditor({ refId })).doc
        assert.isTrue(doc.regex_approved)
        assert.strictEqual((doc.regex as Array<typeof script>)[0]!.find_regex, "/(a+)+$/gi")
      }
      yield* f.api.UndoLibraryEdit({ editId: result.editId! })
      for (const refId of [f.card, f.preset]) {
        const doc = (yield* f.api.OpenEditor({ refId })).doc
        assert.isTrue(doc.regex_approved)
        assert.strictEqual((doc.regex as Array<typeof script>)[0]!.find_regex, "/x/g")
      }
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("leaves a script that was not approved unapproved after a replace", () =>
    Effect.gen(function* () {
      const f = yield* withScripts(false)
      const asked = search("lighthouse", "beacon", { kinds: ["card", "preset"] })
      const preview = yield* f.api.PreviewLibraryReplace({ search: asked })
      const result = yield* f.api.ApplyLibraryReplace({ search: asked, choices: entries(preview) })
      assert.strictEqual(result.entries, 2)
      for (const refId of [f.card, f.preset]) {
        const doc = (yield* f.api.OpenEditor({ refId })).doc
        assert.strictEqual((doc.regex as Array<typeof script>)[0]!.name, "beacon")
        assert.isNotTrue(doc.regex_approved, `${refId}: still not approved`)
      }
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})
