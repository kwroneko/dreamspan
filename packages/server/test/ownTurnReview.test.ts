import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { takeSummaryPrefix, applySummaryPrefix } from "../src/lcm/prefix.ts"
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"

const secret = "MIRA-PRIVATE-SEA"
const fixture = (speaker = "Tobin"): AssemblyFixture => ({
  cards: ["Mira", "Tobin"].map((name) => ({
    entity: name,
    doc: Effect.runSync(
      importCard(
        new TextEncoder().encode(JSON.stringify({ name, description: name === "Mira" ? `Blue. ${secret}` : "Green." }))
      )
    ).card
  })),
  participants: ["Mira", "Tobin"],
  messages: [{ side: "user", content: "The road is clear." }],
  target: { speaker },
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0, group_nudge_prompt: "" })).document!,
  notes: [
    {
      entity: "shared",
      revision: "r",
      doc: {
        schema_version: 1,
        title: "Shared",
        owner: { card: "Mira" as never },
        content: "Blue.",
        placement: { mode: "section", section: "card" },
        replaces: { kind: "card_field", field: "description" },
        move_group: "g",
        on_by_default: true,
        exportable: true
      }
    },
    {
      entity: "private",
      revision: "r",
      doc: {
        schema_version: 1,
        title: "Inner life",
        owner: { card: "Mira" as never },
        content: secret,
        condition: { when: "own_turn" },
        placement: { mode: "section", section: "own_turn" },
        move_group: "g",
        on_by_default: true,
        exportable: true
      }
    }
  ]
})

describe("own-turn audience review", () => {
  for (const speaker of ["Mira", "Tobin"]) {
    it(`Continue follows its version speaker (${speaker})`, async () => {
      const f = fixture(speaker)
      const built = await Effect.runPromise(
        assembleFixture({
          ...f,
          model: {
            connectionId: "synthetic",
            modelId: "synthetic",
            kind: "openai-chat",
            api: "openai-completions",
            key: "synthetic",
            prefill: "none",
            cacheBreakpoints: "auto",
            context: null,
            presetOverride: null
          },
          target: { speaker, continues: { version: "prior-version", text: "The road leads onward." } }
        })
      )
      expect(JSON.stringify(built.request).includes(secret)).toBe(speaker === "Mira")
    })
    it(`an unsent preview follows its selected speaker (${speaker})`, async () => {
      const built = await Effect.runPromise(assembleFixture({ ...fixture(speaker), messages: [] }))
      expect(JSON.stringify(built.request).includes(secret)).toBe(speaker === "Mira")
    })
  }

  for (const withNotes of [false, true])
    for (const speaker of ["Mira", "Tobin"])
      it(`shared summary input excludes private card text (notes ${withNotes}, target ${speaker})`, async () => {
        const f = fixture(speaker)
        const built = await Effect.runPromise(
          assembleFixture(
            {
              ...f,
              events: [
                {
                  depth: null,
                  event: { scope: null, data: { key: "lcm.settings", value: { enabled: true, withNotes } } }
                }
              ]
            },
            { summarizing: true }
          )
        )
        expect(JSON.stringify(built.request)).not.toContain(secret)
        expect(JSON.stringify(built.request)).toContain("Blue.")
      })
  for (const field of [
    "description",
    "personality",
    "scenario",
    "mes_example",
    "system_prompt",
    "post_history_instructions"
  ] as const)
    it(`replacement of ${field} covers preset field macros and example messages`, async () => {
      const f = fixture()
      const notes = f.notes!.map((n) =>
        n.entity === "shared" ? { ...n, doc: { ...n.doc, replaces: { kind: "card_field" as const, field } } } : n
      )
      const p = f.preset.prompts.map((p) =>
        p.identifier === "main" ? { ...p, content: "{{description}} {{personality}} {{scenario}} {{mesExamples}}" } : p
      )
      const built = await Effect.runPromise(
        assembleFixture({
          ...f,
          cards: f.cards.map((c) => ({
            ...c,
            doc: { ...c.doc, description: "Blue.", [field]: c.entity === "Mira" ? `Blue. ${secret}` : "Green." }
          })),
          preset: { ...f.preset, prompts: p },
          notes: notes as ReadonlyArray<{ entity: string; revision: string; doc: NoteDoc }>
        })
      )
      expect(JSON.stringify(built.request)).not.toContain(secret)
    })
})

describe("derived private text review", () => {
  it("does not restore another speaker's own-turn prefix into shared summary input", async () => {
    const f = fixture("Mira")
    const marker = f.preset.order.find((p) => p.identifier === "ownTurnNotes")!
    const beforeHistory = {
      ...f,
      preset: { ...f.preset, order: [marker, ...f.preset.order.filter((p) => p !== marker)] }
    }
    const reply = await Effect.runPromise(assembleFixture(beforeHistory))
    expect(JSON.stringify(reply.request)).toContain(secret)
    const summary = await Effect.runPromise(assembleFixture(beforeHistory, { summarizing: true }))
    expect(JSON.stringify(applySummaryPrefix(summary, takeSummaryPrefix(reply)).request)).not.toContain(secret)
  })
  it("does not activate lore from the replaced original or from a skipped own-turn note", async () => {
    const f = fixture()
    const book = loreBook([
      loreEntry({ keys: [secret], content: "PRIVATE-LORE-DERIVED", match_character_description: true })
    ])
    const built = await Effect.runPromise(
      assembleFixture({
        ...f,
        cards: f.cards.map((c) =>
          c.entity === "Mira" ? { ...c, doc: { ...c.doc, character_book: book.document } } : c
        ),
        notes: f.notes!.map((n) => ({ ...n, doc: { ...n.doc, scan_lore: true } }))
      })
    )
    expect(JSON.stringify(built.request)).not.toContain("PRIVATE-LORE-DERIVED")
    expect(JSON.stringify(built.request)).not.toContain(secret)
  })
  it("expands history templates using the shared replacement", async () => {
    const f = fixture()
    const built = await Effect.runPromise(
      assembleFixture({ ...f, messages: [{ side: "user", content: "{{description}}", macroMode: "template" }] })
    )
    expect(JSON.stringify(built.request)).not.toContain(secret)
  })
  // merge-batch10: thread stretch views (batch 9) add the "~stretch" marker to the audience. Another
  // character's stretch view never takes Mira's own-turn text; her own stretch view leaves it out
  // too, as the gate only admits an audience of exactly the note's card.
  for (const audience of [["Mira"], ["Tobin"], ["Tobin", "~stretch"], ["Mira", "~stretch"]])
    it(`limits a private summary input to its audience (${audience.join(", ")})`, async () => {
      const f = fixture("Mira")
      const built = await Effect.runPromise(
        assembleFixture(
          {
            ...f,
            events: [
              {
                depth: null,
                event: { scope: null, data: { key: "lcm.settings", value: { enabled: true, withNotes: true } } }
              }
            ]
          },
          {
            summarizing: true,
            summaryJob: {
              id: "summary",
              clipTokens: 1000,
              inputs: [],
              tail: "Summarize.",
              style: "direct",
              audience
            }
          }
        )
      )
      expect(JSON.stringify(built.request).includes(secret)).toBe(audience.join() === "Mira")
    })
})
