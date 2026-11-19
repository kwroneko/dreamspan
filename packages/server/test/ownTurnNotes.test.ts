import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import type { NoteDoc } from "@dreamspan/shared/docs/note.ts"
import { ownTurnNotes } from "@dreamspan/shared/presetOrder.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"

const card = (name: string): CardDoc =>
  Effect.runSync(importCard(new TextEncoder().encode(JSON.stringify({ name, description: `${name} wears blue.` }))))
    .card
const note = (
  owner: string,
  content: string,
  placement: NoteDoc["placement"] = { mode: "section", section: "own_turn" }
): NoteDoc => ({
  schema_version: 1,
  title: "Inner life",
  content,
  owner: { card: owner as never },
  condition: { when: "own_turn" },
  placement,
  exportable: true,
  on_by_default: true
})
const preset = () => importStPreset(JSON.stringify({ group_nudge_prompt: "", impersonation_prompt: "" })).document!
const fixture = (speaker: string, placement?: NoteDoc["placement"]): AssemblyFixture => ({
  cards: ["Mira", "Tobin", "Persona", "Narrator"].map((name) => ({ entity: name, doc: card(name) })),
  participants: ["Mira", "Tobin", "Narrator"],
  persona: "Persona",
  target: { speaker },
  messages: [{ side: "user", content: "The road is clear." }],
  preset: preset(),
  notes: ["Mira", "Tobin", "Persona", "Narrator"].map((owner) => ({
    entity: `note-${owner}`,
    revision: "r1",
    doc: note(owner, `${owner}'s secret.`, placement)
  }))
})
const assemble = (f: AssemblyFixture) => Effect.runPromise(assembleFixture(f))
const sent = (s: Awaited<ReturnType<typeof assemble>>) => JSON.stringify(s.request)

describe("own-turn notes", () => {
  it("inserts the marker after history and newest in an imported preset", () => {
    const p = preset()
    expect(p.prompts).toContainEqual(ownTurnNotes)
    expect(
      p.order
        .slice(
          p.order.findIndex((e) => e.identifier === "chatHistory"),
          p.order.findIndex((e) => e.identifier === "chatHistory") + 3
        )
        .map((e) => e.identifier)
    ).toEqual(["chatHistory", "newestMessage", "ownTurnNotes"])
  })
  for (const rotation of [false, true])
    for (const separate of [false, true]) {
      it(`sends only the speaker's notes (rotation ${rotation}, separate ${separate})`, async () => {
        for (const speaker of ["Mira", "Tobin", "Persona", "Narrator"]) {
          const f = fixture(speaker)
          const s = await assemble({
            ...f,
            events: [
              {
                depth: null,
                event: {
                  scope: null,
                  data: { key: "cast.role", value: { entity: "Narrator" as never, role: "narrator" } }
                }
              },
              { depth: null, event: { scope: null, data: { key: "cards.rotation", value: { on: rotation } } } },
              {
                depth: null,
                event: {
                  scope: null,
                  data: { key: "context.per_speaker", value: separate ? "separate" : "shared" }
                }
              }
            ]
          })
          for (const owner of ["Mira", "Tobin", "Persona", "Narrator"])
            expect(sent(s).includes(`${owner}'s secret.`)).toBe(owner === speaker)
          expect(sent(s)).toContain(`<${speaker}>\\n${speaker}'s secret.`)
          expect(s.inputs.viewer ?? null).toBe(
            separate && speaker !== "Persona" && speaker !== "Narrator" ? speaker : null
          )
        }
      })
    }
  it("keeps everything before the marker identical across speakers", async () => {
    const a = await assemble(fixture("Mira")),
      b = await assemble(fixture("Tobin"))
    const prefix = (s: typeof a) => sent(s).split("<Mira>\\nMira's secret.")[0]
    expect(sent(a).indexOf("The road is clear.")).toBeLessThan(sent(a).indexOf("Mira's secret."))
    expect(prefix(a)).toBe(sent(b).split("<Tobin>\\nTobin's secret.")[0])
  })
  it("leaves an unadapted card’s request byte-identical", async () => {
    const f = { ...fixture("Mira"), notes: [] }
    const withMarker = await assemble(f)
    const without = await assemble({
      ...f,
      preset: {
        ...f.preset,
        prompts: f.preset.prompts.filter((p) => p.identifier !== "ownTurnNotes"),
        order: f.preset.order.filter((p) => p.identifier !== "ownTurnNotes")
      }
    })
    expect(JSON.stringify(withMarker.request)).toBe(JSON.stringify(without.request))
  })
  it("follows the version’s speaker on swipes and agent runs", async () => {
    for (const speaker of ["Mira", "Tobin"]) {
      const f = fixture(speaker)
      const s = await Effect.runPromise(
        assembleFixture(
          { ...f, target: { speaker, ordinal: 23 } },
          { agent: { instructions: "Use the offered tools.", speakerCardOnly: false } }
        )
      )
      expect(sent(s)).toContain(`${speaker}'s secret.`)
      expect(sent(s)).not.toContain(`${speaker === "Mira" ? "Tobin" : "Mira"}'s secret.`)
    }
  })
  it("keeps a marker slot volatile even when its card note says Always", async () => {
    const f = fixture("Mira")
    const marker = f.preset.order.find((e) => e.identifier === "ownTurnNotes")!
    const s = await assemble({
      ...f,
      notes: f.notes!.map((n) => ({ ...n, doc: { ...n.doc, condition: { when: "always" as const } } })),
      preset: { ...f.preset, order: [marker, ...f.preset.order.filter((e) => e !== marker)] }
    })
    expect(s.issues.some((i) => i.kind === "cache_breakpoints")).toBe(true)
    expect(sent(s)).not.toContain("Tobin's secret.")
  })
  it("moves the marker above history and warns about the changing prefix", async () => {
    const f = fixture("Mira")
    const marker = f.preset.order.find((e) => e.identifier === "ownTurnNotes")!
    const s = await assemble({
      ...f,
      preset: { ...f.preset, order: [marker, ...f.preset.order.filter((e) => e !== marker)] }
    })
    expect(sent(s).indexOf("Mira's secret.")).toBeLessThan(sent(s).indexOf("The road is clear."))
    expect(s.issues.some((i) => i.kind === "cache_breakpoints")).toBe(true)
  })
  it("falls back at the tail and explains a missing marker", async () => {
    const f = fixture("Mira")
    const s = await assemble({
      ...f,
      preset: {
        ...f.preset,
        prompts: f.preset.prompts.filter((p) => p.identifier !== "ownTurnNotes"),
        order: f.preset.order.filter((p) => p.identifier !== "ownTurnNotes")
      }
    })
    expect(sent(s)).toContain("Mira's secret.")
    expect(
      s.issues.some(
        (i) => i.message === "Own-turn notes sent at the start of the tail: this preset has no Own-turn notes marker"
      )
    ).toBe(true)
  })
  it("retains a skipped note’s inspector reason when card swap leaves its definitions out", async () => {
    const f = fixture("Tobin", { mode: "section", section: "card" })
    const s = await assemble({
      ...f,
      events: [{ depth: null, event: { scope: null, data: { key: "cards.rotation", value: { on: true } } } }]
    })
    expect(
      s.pieces.some(
        (p) =>
          p.source.kind === "note" &&
          p.source.entity === "note-Mira" &&
          p.source.activation?.due === false &&
          p.source.activation.condition === "only on Mira's turns"
      )
    ).toBe(true)
  })
  it("honours an ordinary note position and never sends another speaker's note", async () => {
    const s = await assemble(fixture("Tobin", { mode: "section", section: "context_start" }))
    expect(sent(s)).toContain("Tobin's secret.")
    expect(sent(s)).not.toContain("Mira's secret.")
  })
})
