import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { importStPreset } from "../src/formats/preset.ts"
import type { AssemblyFixture } from "./support/assemblySources.ts"
import { assembleFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const fixture = (layout: "parallel" | "join"): AssemblyFixture => ({
  cards: [
    { entity: "mira", doc: cardDoc("Mira") },
    { entity: "kai", doc: cardDoc("Kai") }
  ],
  participants: ["mira", "kai"],
  target: { speaker: "mira" },
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!,
  messages: [
    { side: "assistant", speaker: "mira", content: "HOME-FACT" },
    {
      side: "user",
      content: "Kai: <b>DOCKS-KEY</b>",
      merge: { id: "merge", title: "Docks", framing: null, start: "slot-0", cast: ["Kai"] }
    },
    { side: "user", content: "AFTER" }
  ],
  events: [
    { depth: null, event: { scope: null, data: { key: "merge.layout", value: layout } } },
    { depth: null, event: { scope: null, data: { key: "lorebook.below_history", value: { on: false } } } },
    { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: "book" as never } } } }
  ],
  lorebooks: [
    {
      id: "book",
      entity: "book",
      revision: "book-r",
      doc: loreBook([loreEntry({ keys: ["DOCKS-KEY"], content: "DOCKS-LORE", scan_depth: 100 })]).document
    }
  ]
})

for (const layout of ["parallel", "join"] as const) {
  it.effect(`lore scans a merged section independently of its join marker (${layout})`, () =>
    Effect.gen(function* () {
      const snapshot = yield* assembleFixture(fixture(layout))
      assert.include(JSON.stringify(snapshot.request), "DOCKS-KEY")
      assert.include(JSON.stringify(snapshot.request), "DOCKS-LORE")
    })
  )
  it.effect(`HTML depth transforms a merged section independently of its marker (${layout})`, () =>
    Effect.gen(function* () {
      const f = fixture(layout)
      const snapshot = yield* assembleFixture({
        ...f,
        lorebooks: [],
        events: [
          ...f.events!,
          { depth: null, event: { scope: null, data: { key: "context.html_depth", value: { mode: "text", n: 1 } } } }
        ]
      })
      const text = JSON.stringify(snapshot.request)
      assert.include(text, "DOCKS-KEY")
      assert.notInclude(text, "<b>")
      assert.include(text, "joins this chat")
    })
  )
}

it.effect("a shallow scan does not reach back past the join marker and following message", () =>
  Effect.gen(function* () {
    const f = fixture("join")
    const snapshot = yield* assembleFixture({
      ...f,
      lorebooks: f.lorebooks!.map((b) => ({
        ...b,
        doc: { ...b.doc, entries: b.doc.entries.map((e) => ({ ...e, scan_depth: 2 })) }
      }))
    })
    assert.include(JSON.stringify(snapshot.request), "DOCKS-KEY")
    assert.notInclude(JSON.stringify(snapshot.request), "DOCKS-LORE")
  })
)
