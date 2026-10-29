import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { promptPreset } from "@rp/shared/docs/preset.ts"
import { exportStPreset, importStPreset } from "../src/formats/preset.ts"
import { assembleFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const preset = () => importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!
const build = (switches: Record<string, boolean>, crowded = false) =>
  Effect.runPromise(
    assembleFixture({
      preset: {
        ...preset(),
        ...switches,
        prompts: preset().prompts.map((p) =>
          p.identifier === "main" ? { ...p, content: "Preset\n\nprompt", forbid_overrides: true } : p
        ),
        samplers: { ...preset().samplers, openai_max_context: crowded ? 800 : 4000, openai_max_tokens: 100 },
        context_target: crowded ? 700 : 3500,
        utility_prompts: { ...preset().utility_prompts, card_join_prefix: "", card_join_suffix: "" }
      },
      cards: [
        {
          entity: "mira",
          doc: {
            ...cardDoc("Mira"),
            description: "First\n\n\n{{char}} last",
            mes_example: "<START>\nUser: Example question\nMira: Example\n\nanswer"
          }
        },
        { entity: "persona", doc: { ...cardDoc("User"), description: "Persona first\n\nlast" } }
      ],
      persona: "persona",
      participants: ["mira"],
      messages: Array.from({ length: crowded ? 30 : 1 }, (_, i) => ({
        side: "user" as const,
        content: `History ${i}\n\n${"road ".repeat(crowded ? 20 : 1)}`
      }))
    })
  )

describe("ST preset text switches", () => {
  it("imports and exports switches as prompt settings, leaving model settings separate", () => {
    const doc = importStPreset(
      JSON.stringify({ frequency_penalty: 0, pin_examples: true, strip_examples: true, collapse_newlines: true })
    ).document!
    const prompt = promptPreset(doc)
    expect(prompt).toMatchObject({ pin_examples: true, strip_examples: true, collapse_newlines: true })
    expect(prompt).not.toHaveProperty("samplers")
    expect(doc.unsupported).not.toHaveProperty("pin_examples")
    expect(importStPreset(JSON.stringify(exportStPreset(doc))).document).toEqual(doc)
  })
  it("collapses expanded card fields and examples, retaining saved history and source attribution", async () => {
    const off = await build({ collapse_newlines: false })
    const on = await build({ collapse_newlines: true })
    const text = (snapshot: typeof on) => JSON.stringify(snapshot.request.messages)
    expect(text(off)).toContain("First\\n\\n\\nMira last")
    expect(text(on)).toContain("First\\nMira last")
    expect(text(on)).toContain("History 0\\n\\nroad")
    expect(text(on)).toContain("Example\\nanswer")
    expect(text(on)).toContain("Preset\\n\\nprompt")
    expect(text(on)).toContain("Persona first\\nlast")
    expect(text(off)).toContain("Persona first\\n\\nlast")
    expect(on.pieces.find((p) => p.source.kind === "card" && p.text === "First\nMira last")).toBeDefined()
  })
  it("strips examples even with pinning on", async () => {
    expect(JSON.stringify((await build({})).request)).toContain("Example question")
    expect(JSON.stringify((await build({ strip_examples: true, pin_examples: true })).request)).not.toContain(
      "Example question"
    )
  })
  it("strips lorebook examples too, while collapse updates their source text", async () => {
    const fixture = {
      preset: preset(),
      participants: ["mira"],
      cards: [{ entity: "mira", doc: cardDoc("Mira") }],
      messages: [{ side: "user" as const, content: "A message" }],
      events: [
        { depth: null, event: { scope: null, data: { key: "lorebook.attach", value: { ref: "book" as never } } } },
        { depth: null, event: { scope: null, data: { key: "lorebook.below_history", value: { on: false } } } }
      ] as const,
      lorebooks: [
        {
          id: "book",
          entity: "book",
          revision: "book-rev",
          doc: loreBook([
            loreEntry({
              constant: true,
              position: "em_top",
              content: "<START>\nUser: Lore question\nMira: Lore\n\nanswer"
            })
          ]).document
        }
      ]
    }
    const on = await Effect.runPromise(
      assembleFixture({ ...fixture, preset: { ...fixture.preset, collapse_newlines: true } })
    )
    expect(JSON.stringify(on.request)).toContain("Lore question")
    expect(JSON.stringify(on.request)).toContain("Lore\\nanswer")
    expect(on.pieces.some((p) => p.source.kind === "lorebook" && p.text.includes("Lore\nanswer"))).toBe(true)
    const stripped = await Effect.runPromise(
      assembleFixture({ ...fixture, preset: { ...fixture.preset, strip_examples: true, pin_examples: true } })
    )
    expect(JSON.stringify(stripped.request)).not.toContain("Lore question")
  })
  it("gives pinned examples priority over history when the window fills", async () => {
    const off = await build({ pin_examples: false }, true)
    const on = await build({ pin_examples: true }, true)
    expect(JSON.stringify(on.request)).toContain("Example question")
    const history = (snapshot: typeof on) =>
      snapshot.request.messages.filter((m) => m.content.includes("History ")).length
    expect(history(on)).toBeLessThan(history(off))
    expect(history(on)).toBeGreaterThan(0)
  })
})
