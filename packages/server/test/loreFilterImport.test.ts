import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { card } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "ST character filter mapping",
  (it) => {
    it.effect(
      "resolves filename and tag IDs before storing, preserves them across reimport, and offers picker data",
      () =>
        Effect.gen(function* () {
          const files = new Map([
            ["settings.json", bytes({ tags: [{ id: "tag-a", name: "Mages" }], tag_map: { "alice.png": ["tag-a"] } })],
            ["characters/alice.png", card("Alice", "Hello")],
            [
              "worlds/Filters.json",
              bytes({
                entries: {
                  0: { key: ["cat"], characterFilter: { names: ["alice"], tags: ["tag-a"], isExclude: false } }
                }
              })
            ]
          ])
          const { api } = yield* importStFolder(files)
          const userId = (yield* api.Whoami()).id
          const sources = yield* (yield* Reader).StImportSources({ userId })
          const alice = sources.library.find((r) => r.sourcePath === "characters/alice.png")!
          const book = sources.library.find((r) => r.sourcePath === "worlds/Filters.json")!
          const before = yield* api.OpenEditor({ refId: book.refId })
          assert.deepStrictEqual((before.doc.entries as Array<{ character_filter: unknown }>)[0]!.character_filter, {
            names: [],
            cards: [{ entity: alice.entityId, name: "alice" }],
            tags: ["Mages"],
            tag_ids: { Mages: "tag-a" },
            is_exclude: false
          })
          const cards = yield* api.ListLibrary({ kind: "card", withFilterData: true })
          assert.deepStrictEqual(cards.find((c) => c.entityId === alice.entityId)!.filterData, {
            name: "alice",
            tags: ["Mages"]
          })
          yield* importStFolder(files)
          assert.deepStrictEqual((yield* api.OpenEditor({ refId: book.refId })).doc, before.doc)
        })
    )
  }
)
