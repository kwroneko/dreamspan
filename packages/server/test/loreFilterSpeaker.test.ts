import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { assembleFixture } from "./support/assemblySources.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { json, run } from "./formats/support.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const card = (name: string, tags: ReadonlyArray<string>) =>
  run(importCard(json({ spec: "chara_card_v2", spec_version: "2.0", data: { name, tags } }))).card

describe("character filters use the writing speaker", () => {
  for (const speaker of ["alice", "bob"]) {
    it(`uses ${speaker}'s card and tags in a multi-character cast`, async () => {
      const book = loreBook([
        loreEntry({
          constant: true,
          content: "BOB FILTERED LORE",
          character_filter: {
            names: [],
            cards: [{ entity: "bob", name: "bob-file" }],
            tags: ["Mages"],
            is_exclude: false
          }
        })
      ])
      const snapshot = await Effect.runPromise(
        assembleFixture({
          cards: [
            { entity: "alice", doc: card("Alice", []) },
            { entity: "bob", doc: card("Bob", ["Mages"]) }
          ],
          participants: ["alice", "bob"],
          messages: [{ side: "user", content: "Hello" }],
          target: { speaker },
          preset: importStPreset('{"main_prompt":"Write the scene."}').document!,
          lorebooks: [{ id: book.id, entity: "book", revision: "book-rev", doc: book.document }],
          events: [
            { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: book.id as never } } } }
          ]
        })
      )
      expect(JSON.stringify(snapshot.request).includes("BOB FILTERED LORE")).toBe(speaker === "bob")
    })
  }
})
