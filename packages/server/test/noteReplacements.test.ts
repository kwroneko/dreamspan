// Notes that replace prompts (DESIGN §4.2, spec/NOTE-OVERRIDES.md §3): a note on in the chat is
// sent in a preset prompt's or card field's place; empty, the prompt is off; off, the prompt is
// back; with its own position it goes there and the prompt is left out. Made-up cards and the
// built-in default preset.
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import type { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { PositionedEvent } from "../src/assembler/pipeline.ts"
import type { ContextSnapshot, NoteInput } from "../src/assembler/types.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { json, run } from "./formats/support.ts"
import { type AssemblyFixture, assembleFixture } from "./support/assemblySources.ts"

const card = (name: string, fields: Partial<Record<keyof CardDoc, unknown>> = {}): CardDoc =>
  run(
    importCard(
      json({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name, description: "", personality: "", scenario: "", first_mes: "", mes_example: "", ...fields }
      })
    )
  ).card

const preset = (fields: Record<string, unknown> = {}): PresetDoc =>
  importStPreset(JSON.stringify({ frequency_penalty: 0, group_nudge_prompt: "", wi_format: "{0}", ...fields }))
    .document!

const unwrapped = (doc: PresetDoc): PresetDoc => ({
  ...doc,
  utility_prompts: { ...doc.utility_prompts, card_join_prefix: "", card_join_suffix: "" }
})

const mira = card("Mira", { description: "Mira keeps the ledger. She wears a grey coat.", personality: "Exact." })
const mira2 = card("Mira", { description: "Mira, forked: keeps the ledger.", personality: "Exact." })
const tobin = card("Tobin", { description: "Tobin draws maps." })

const at = (depth: number | null, data: StateEventData): PositionedEvent => ({ depth, event: { scope: null, data } })
const on = (...notes: ReadonlyArray<string>) =>
  notes.map((note) => at(null, { key: "note.activate", value: { note: note as never } }))

const chatNote = (entity: string, content: string, fields: Partial<NoteDoc> = {}): NoteInput => ({
  entity,
  revision: `${entity}-revision`,
  doc: {
    schema_version: 1,
    title: entity,
    content,
    placement: { mode: "depth", depth: 4, role: "system" },
    owner: { chat: "chat-1" as never },
    exportable: false,
    ...fields
  }
})

const fixture = (fields: Partial<AssemblyFixture> = {}): AssemblyFixture => ({
  messages: [
    { side: "assistant", content: "You're late." },
    { side: "user", content: "The road flooded." }
  ],
  cards: [
    { entity: "mira", doc: mira },
    { entity: "mira-fork", doc: mira2 },
    { entity: "tobin", doc: tobin }
  ],
  participants: ["mira"],
  persona: "tobin",
  preset: unwrapped(preset()),
  ...fields
})

const assembled = (f: AssemblyFixture) => Effect.runPromise(assembleFixture(f))
const contents = (snapshot: ContextSnapshot) => snapshot.request.messages.map((m) => `${m.role}: ${m.content}`)
const sent = (snapshot: ContextSnapshot) => contents(snapshot).join("\n")

describe("notes that replace prompts", () => {
  it("expands {{original}} at a replacing note's own position", async () => {
    const note = chatNote("note-own-original", "Before: {{original}}", {
      replaces: { kind: "card_field", field: "description", card: "mira" as never },
      own_position: true,
      placement: { mode: "tail", role: "system" }
    })
    const snapshot = await assembled(fixture({ notes: [note], events: on(note.entity) }))
    expect(sent(snapshot)).toContain("Before: Mira keeps the ledger. She wears a grey coat.")
    expect(sent(snapshot).match(/grey coat/g)).toHaveLength(1)
  })

  it.each([
    { template: undefined, content: "Before: {{original}}" },
    { template: "[{{summary}}]", content: "Before: {{original}}" },
    { template: "Before: {{original}}", content: "Summary text." }
  ])("expands {{original}} in an imported summary at its own position ($template)", async ({ template, content }) => {
    const note = chatNote("summary-original", content, {
      kind: "imported_summary",
      ...(template === undefined ? {} : { template }),
      replaces: { kind: "card_field", field: "description", card: "mira" as never },
      own_position: true,
      placement: { mode: "tail", role: "system" }
    })
    const snapshot = await assembled(fixture({ notes: [note], events: on(note.entity) }))
    expect(sent(snapshot)).toContain("Before: Mira keeps the ledger. She wears a grey coat.")
    expect(sent(snapshot).match(/grey coat/g)).toHaveLength(1)
  })

  it("keeps the persona's bindings when {{original}} is read at the note's own position", async () => {
    const note = chatNote("persona-original", "Before: {{original}}", {
      replaces: { kind: "card_field", field: "description", card: "tobin" as never },
      own_position: true,
      placement: { mode: "tail", role: "system" }
    })
    const snapshot = await assembled(
      fixture({
        notes: [note],
        events: on(note.entity),
        cards: [
          { entity: "mira", doc: mira },
          { entity: "tobin", doc: { ...tobin, description: "{{user}} follows {{char}}." } }
        ]
      })
    )
    expect(sent(snapshot)).toContain("Before: Tobin follows Mira.")
  })

  it("keeps the examples' cache boundary when a conditional replacement is empty", async () => {
    const note = chatNote("empty-examples", "", {
      replaces: { kind: "card_field", field: "mes_example", card: "mira" as never },
      condition: { when: "turn", cards: ["mira" as never] }
    })
    const snapshot = await assembled(fixture({ notes: [note], events: on(note.entity) }))
    const history = snapshot.request.messages.findIndex((m) => m.content.includes("[Start a new Chat]"))
    expect(history).toBeGreaterThan(0)
    expect(snapshot.request.breakpoints.every((b) => b.message < history)).toBe(true)
  })

  it("keeps an empty conditional field replacement outside the cached prefix", async () => {
    const note = chatNote("note-conditional-empty", "", {
      replaces: { kind: "card_field", field: "description", card: "mira" as never },
      condition: { when: "turn", cards: ["mira" as never] }
    })
    const snapshot = await assembled(fixture({ notes: [note], events: on(note.entity) }))
    const personality = snapshot.request.messages.findIndex((m) => m.content.includes("Exact."))
    expect(personality).toBeGreaterThan(0)
    expect(snapshot.request.breakpoints.every((b) => b.message < personality)).toBe(true)
  })

  it("keeps a conditional Main replacement volatile when the card overrides Main on a skipped turn", async () => {
    const note = chatNote("note-conditional-main", "Only for Tobin.", {
      replaces: { kind: "preset_prompt", identifier: "main" },
      condition: { when: "turn", cards: ["tobin" as never] }
    })
    const snapshot = await assembled(
      fixture({
        notes: [note],
        events: on(note.entity),
        cards: [
          { entity: "mira", doc: { ...mira, system_prompt: "Mira's own system prompt." } },
          { entity: "tobin", doc: tobin }
        ]
      })
    )
    expect(sent(snapshot)).toContain("Mira's own system prompt.")
    expect(snapshot.request.breakpoints).toEqual([])
  })

  it("sends the note in a card field's place, with {{original}} its text, and the field back once off", async () => {
    const outfit = chatNote("note-outfit", "{{original}} Today: a red scarf.", {
      replaces: { kind: "card_field", field: "description", card: "mira" as never }
    })
    const replaced = await assembled(fixture({ notes: [outfit], events: on("note-outfit") }))
    expect(sent(replaced)).toContain("system: Mira keeps the ledger. She wears a grey coat. Today: a red scarf.")
    // Not also placed as a note of its own (its placement is ignored).
    expect(sent(replaced).match(/red scarf/g)).toHaveLength(1)
    expect(replaced.noteReplacements?.map((r) => r.status)).toEqual(["replaced"])
    const piece = replaced.pieces[replaced.noteReplacements![0]!.piece!]!
    expect(piece.source).toMatchObject({ kind: "note", entity: "note-outfit" })

    const off = await assembled(fixture({ notes: [outfit] }))
    expect(sent(off)).toContain("system: Mira keeps the ledger. She wears a grey coat.")
    expect(sent(off)).not.toContain("red scarf")
  })

  it("leaves the prompt out when the note is empty, and goes at its own position when it has one", async () => {
    const empty = chatNote("note-empty", "", {
      replaces: { kind: "card_field", field: "personality", card: "mira" as never }
    })
    const quiet = await assembled(fixture({ notes: [empty], events: on("note-empty") }))
    expect(sent(quiet)).not.toContain("Exact.")

    const own = chatNote("note-own", "Mira's description, at depth 0.", {
      replaces: { kind: "card_field", field: "description", card: "mira" as never },
      own_position: true,
      placement: { mode: "depth", depth: 0, role: "system" }
    })
    const placed = await assembled(fixture({ notes: [own], events: on("note-own") }))
    expect(sent(placed)).not.toContain("grey coat")
    const lines = contents(placed)
    expect(lines.indexOf("system: Mira's description, at depth 0.")).toBeGreaterThan(
      lines.indexOf("user: The road flooded.")
    )
  })

  it("replaces a preset prompt by its identifier, and a chat's note wins over the card's own system prompt", async () => {
    const main = chatNote("note-main", "Write tersely. ({{original}})", {
      replaces: { kind: "preset_prompt", identifier: "main" }
    })
    const doc = await assembled(
      fixture({
        notes: [main],
        events: on("note-main"),
        cards: [
          { entity: "mira", doc: { ...mira, system_prompt: "Mira's own system prompt." } },
          { entity: "tobin", doc: tobin }
        ]
      })
    )
    expect(sent(doc)).toMatch(/system: Write tersely\. \(Write Mira's next reply/)
    expect(sent(doc)).not.toContain("Mira's own system prompt.")
    expect(doc.cardOverrides ?? []).toEqual([])
  })

  it("follows the character's place through a swap to the card forked for this chat", async () => {
    const outfit = chatNote("note-outfit", "Replaced on whichever card is Mira here.", {
      replaces: { kind: "card_field", field: "description", card: "mira" as never }
    })
    const swapped = await assembled(
      fixture({
        notes: [outfit],
        events: [
          ...on("note-outfit"),
          at(1, { key: "card.swap", value: { entity: "mira-fork" as never, replaces: "mira" as never } })
        ]
      })
    )
    expect(sent(swapped)).toContain("system: Replaced on whichever card is Mira here.")
    expect(sent(swapped)).not.toContain("forked: keeps")
    expect(swapped.noteReplacements?.[0]?.target).toEqual({
      kind: "card_field",
      card: "mira-fork",
      field: "description"
    })
  })

  it("keeps one note per target, refuses a card's note where the prompt forbids overrides, and reports a missing prompt", async () => {
    const first = chatNote("note-a", "First.", { replaces: { kind: "preset_prompt", identifier: "main" } })
    const second = chatNote("note-b", "Second.", { replaces: { kind: "preset_prompt", identifier: "main" } })
    const gone = chatNote("note-c", "Gone.", { replaces: { kind: "preset_prompt", identifier: "no-such-prompt" } })
    const both = await assembled(fixture({ notes: [first, second, gone], events: on("note-a", "note-b", "note-c") }))
    expect(sent(both)).toContain("system: First.")
    expect(sent(both)).not.toContain("Second.")
    expect(sent(both)).not.toContain("Gone.")
    expect(both.noteReplacements?.map((r) => [r.entity, r.status])).toEqual([
      ["note-a", "replaced"],
      ["note-b", "conflict"],
      ["note-c", "missing"]
    ])
    expect(both.issues.map((i) => i.kind)).toContain("note_replacement")

    const cardNote: NoteInput = {
      ...chatNote("note-card", "From the card.", { replaces: { kind: "preset_prompt", identifier: "main" } }),
      doc: {
        ...chatNote("note-card", "From the card.").doc,
        owner: { card: "mira" as never },
        on_by_default: true,
        replaces: { kind: "preset_prompt", identifier: "main" }
      }
    }
    const strict = preset()
    const forbidding = {
      ...strict,
      prompts: strict.prompts.map((p) => (p.identifier === "main" ? { ...p, forbid_overrides: true } : p))
    }
    const kept = await assembled(fixture({ notes: [cardNote], preset: unwrapped(forbidding) }))
    expect(sent(kept)).not.toContain("From the card.")
    expect(kept.noteReplacements?.[0]?.status).toBe("forbidden")
    const allowed = await assembled(fixture({ notes: [cardNote] }))
    expect(sent(allowed)).toContain("system: From the card.")
  })

  it("replaces the field in a card-swap agent reply's tail card", async () => {
    const outfit = chatNote("note-outfit", "Mira, at the tail, in a red scarf.", {
      replaces: { kind: "card_field", field: "description", card: "mira" as never }
    })
    const swap = await Effect.runPromise(
      assembleFixture(fixture({ notes: [outfit], events: on("note-outfit") }), {
        agent: { instructions: "Write Mira's reply.", cardsAtTail: true }
      })
    )
    expect(sent(swap)).toContain("Mira, at the tail, in a red scarf.")
    expect(sent(swap)).not.toContain("grey coat")
    expect(sent(swap).match(/red scarf/g)).toHaveLength(1)
    expect(swap.noteReplacements?.map((r) => r.status)).toEqual(["replaced"])
  })

  it("leaves the field as it is on a turn the note's condition doesn't hold", async () => {
    const onOrens = chatNote("note-turn", "Only on Oren's turn.", {
      replaces: { kind: "card_field", field: "description", card: "mira" as never },
      condition: { when: "turn", cards: ["oren" as never] }
    })
    const snapshot = await assembled(fixture({ notes: [onOrens], events: on("note-turn") }))
    expect(sent(snapshot)).toContain("grey coat")
    expect(snapshot.noteReplacements?.[0]?.status).toBe("not_due")
  })
})
