import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { textField } from "@rp/shared/editing.ts"
import type { LibraryPreview, LibrarySearch } from "@rp/shared/libraryReplace.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const search = (find: string, replace: string): LibrarySearch => ({
  find,
  replace,
  matchCase: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  kinds: ["card", "lorebook", "preset", "note"]
})
const choices = (p: LibraryPreview) =>
  p.entries.map((e) => ({ refId: e.refId, stamp: e.stamp, fields: e.fields.map((f) => f.field) }))

describe("library replace review", () => {
  it.effect("two concurrent replaces commit only one revision and report the stale entry", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ref = yield* api.CreateCard({ label: "Race", name: "Race", description: "lighthouse" })
      const asked = search("lighthouse", "beacon")
      const preview = yield* api.PreviewLibraryReplace({ search: asked })
      const results = yield* Effect.all(
        [
          api.ApplyLibraryReplace({ search: asked, choices: choices(preview) }),
          api.ApplyLibraryReplace({ search: asked, choices: choices(preview) })
        ],
        { concurrency: 2 }
      )
      assert.deepStrictEqual(results.map((r) => r.entries).sort(), [0, 1])
      assert.strictEqual(results.find((r) => r.entries === 0)!.skipped[0]!.refId, ref.id)
      assert.lengthOf(yield* api.ListRevisions({ refId: ref.id, limit: 10 }), 2)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("edits text leaves without treating JSON, regex, macros or keys as document structure", () =>
    Effect.gen(function* () {
      const api = yield* client(),
        writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const create = (kind: "card" | "lorebook" | "preset", doc: Record<string, unknown>) =>
        writer.CreateEntity({
          userId,
          kind,
          label: kind,
          subtitle: "",
          doc,
          schemaVersion: 1,
          origin: "import",
          sourcePath: null
        })
      const book = loreBook([
        loreEntry(
          {
            keys: ["{{char}}", "untouched"],
            secondary_keys: ["prefix {{char}} suffix"],
            content: '{"who":"{{char}}"}'
          },
          7
        )
      ]).document
      const card = yield* create(
        "card",
        cardDoc("Card", {
          description: '{"who":"{{char}}"}',
          alternate_greetings: ["{{char}}", "unchanged"],
          character_book: book
        })
      )
      const preset = yield* create(
        "preset",
        presetDoc([{ identifier: "main", content: "{{char}}" }]) as unknown as Record<string, unknown>
      )
      const lore = yield* create("lorebook", book)
      const asked = search("{{char}}", 'quoted "\\ value\n')
      const preview = yield* api.PreviewLibraryReplace({ search: asked })
      yield* api.ApplyLibraryReplace({ search: asked, choices: choices(preview) })
      const after = yield* api.OpenEditor({ refId: card.ref.id })
      assert.deepStrictEqual(after.doc.alternate_greetings, [asked.replace, "unchanged"])
      assert.strictEqual(after.doc.description, `{"who":"${asked.replace}"}`)
      const actual = (yield* api.OpenEditor({ refId: lore.ref.id })).doc.entries as Array<Record<string, unknown>>
      assert.deepStrictEqual(actual[0]!.keys, [asked.replace, "untouched"])
      assert.strictEqual(actual[0]!.uid, 7)
      assert.strictEqual(
        ((yield* api.OpenEditor({ refId: preset.ref.id })).doc.prompts as Array<Record<string, unknown>>)[0]!.content,
        asked.replace
      )
      // Quotes and backslashes remain text leaves in the document.
      const next = search('quoted "', "replacement")
      const again = yield* api.PreviewLibraryReplace({ search: next })
      assert.isTrue(again.entries.some((e) => e.fields.some((f) => f.field === textField(["description"]))))
      // Matches may cross a macro delimiter: replacements are literal, as in the editor.
      const split = yield* api.CreateCard({ label: "Split", name: "Split", description: "before {{char}} after" })
      const crossing = search("ar}} af", "X")
      yield* api.ApplyLibraryReplace({
        search: crossing,
        choices: choices(yield* api.PreviewLibraryReplace({ search: crossing }))
      })
      assert.strictEqual((yield* api.OpenEditor({ refId: split.id })).doc.description, "before {{chXter")
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})
