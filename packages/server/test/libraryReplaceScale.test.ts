// Search and replace across the library at a large library's scale (ARCHITECTURE §14.6 "Across
// the library"): 2,000 cards of about 8 KB of text each, 40 lorebooks of 300 entries and 50
// presets, every card and entry saying {{char}}. Budget (stated in ARCHITECTURE §14.6), on a
// shared host: a word in a few entries previews in under 0.5 s (the saved text is filtered in
// SQL first); {{char}} everywhere previews in under 3 s and is replaced in all 2,000 cards and
// 40 books in under 10 s (measured 0.07 s, 0.85 s and 3.2 s).
import { assert, describe, it } from "@effect/vitest"
import type { LibrarySearch } from "@dreamspan/shared/libraryReplace.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const CARDS = 2000
const BOOKS = 40
const ENTRIES = 300
const PRESETS = 50

const prose = (n: number, words: number) =>
  Array.from({ length: words }, (_, i) => ["tide", "harbour", "lantern", "gull", "rope", "salt"][(n + i) % 6]).join(" ")

const search = (find: string, replace: string): LibrarySearch => ({
  find,
  replace,
  matchCase: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  kinds: ["card", "lorebook", "preset", "note"]
})

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = performance.now()
    const value = yield* effect
    return { value, ms: performance.now() - start }
  })

describe("library search and replace at scale", () => {
  const config = testConfig()
  it.effect(
    "previews and replaces across 2,000 cards, 40 lorebooks and 50 presets within the budget",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const userId = (yield* api.Whoami()).id
        const writer = yield* Writer
        for (let i = 0; i < CARDS; i++)
          yield* writer.CreateEntity({
            userId,
            kind: "card",
            label: `Card ${i}`,
            subtitle: "",
            doc: cardDoc(`Card ${i}`, {
              description: `{{char}} ${prose(i, 1100)}${i % 500 === 0 ? " the zeppelin moors." : ""}`,
              first_mes: `{{char}} looks up. ${prose(i + 1, 300)}`
            }),
            schemaVersion: 1,
            origin: "import",
            sourcePath: null
          })
        for (let b = 0; b < BOOKS; b++)
          yield* writer.CreateEntity({
            userId,
            kind: "lorebook",
            label: `Book ${b}`,
            subtitle: "",
            doc: loreBook(
              Array.from({ length: ENTRIES }, (_, e) =>
                loreEntry({ keys: [`key${e}`], content: `{{char}} knows ${prose(e, 60)}` }, e)
              ),
              {},
              `Book ${b}`
            ).document,
            schemaVersion: 1,
            origin: "import",
            sourcePath: null
          })
        for (let p = 0; p < PRESETS; p++)
          yield* writer.CreateEntity({
            userId,
            kind: "preset",
            label: `Preset ${p}`,
            subtitle: "",
            doc: presetDoc([{ identifier: "main", content: `Write as {{char}}. ${prose(p, 200)}` }]),
            schemaVersion: 1,
            origin: "import",
            sourcePath: null
          })

        const rare = yield* timed(api.PreviewLibraryReplace({ search: search("zeppelin", "airship") }))
        process.stderr.write(`library preview, rare word: ${rare.ms.toFixed(0)} ms\n`)
        assert.strictEqual(rare.value.entries.length, CARDS / 500)
        assert.isBelow(rare.ms, 500)

        const everywhere = search("{{char}}", "Mira")
        const preview = yield* timed(api.PreviewLibraryReplace({ search: everywhere }))
        process.stderr.write(`library preview, {{char}} everywhere: ${preview.ms.toFixed(0)} ms\n`)
        assert.strictEqual(preview.value.entries.length, CARDS + BOOKS + PRESETS)
        assert.strictEqual(preview.value.counts.find((c) => c.kind === "lorebook")!.matches, BOOKS * ENTRIES)
        assert.isBelow(preview.ms, 3000)

        const choices = preview.value.entries
          .filter((e) => e.kind !== "preset")
          .map((e) => ({ refId: e.refId, stamp: e.stamp, fields: e.fields.map((f) => f.field) }))
        const applied = yield* timed(api.ApplyLibraryReplace({ search: everywhere, choices }))
        process.stderr.write(`library replace, ${choices.length} entries: ${applied.ms.toFixed(0)} ms\n`)
        assert.strictEqual(applied.value.entries, CARDS + BOOKS)
        assert.isBelow(applied.ms, 10000)

        const storage = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT count(*) AS entries, sum(length(group_id)+length(ref_id)+length(before_revision_id)+length(after_revision_id)) AS id_bytes FROM library_edit_items"
            },
            {
              sql: "SELECT sum(pgsize) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name='library_edit_items')"
            }
          ],
          { readOnly: true }
        )
        process.stderr.write(`library edit metadata storage: ${JSON.stringify(storage)}\n`)
        const undone = yield* timed(api.UndoLibraryEdit({ editId: applied.value.editId! }))
        process.stderr.write(`library undo: ${undone.ms.toFixed(0)} ms\n`)
        assert.strictEqual(undone.value.undone, CARDS + BOOKS)
      }).pipe(Effect.provide(serverLayer(config))),
    { timeout: 600_000 }
  )
})
