// Notes in assembly (DESIGN §4.1): the five positions, conditions (on a card's turn, while a
// card isn't muted), their cache behaviour, the lorebook scan switch and "on in every chat".
// Synthetic cards and notes only.
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import type { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { PositionedEvent } from "../src/assembler/pipeline.ts"
import type { ContextSnapshot, ModelInput, NoteInput } from "../src/assembler/types.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { type AssemblyFixture, assembleFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"

const model: ModelInput = {
  connectionId: "connection",
  modelId: "model",
  kind: "openai-chat",
  api: "openai-completions",
  key: "test-model",
  prefill: "none",
  cacheBreakpoints: "auto",
  context: null,
  presetOverride: null
}

const preset = (fields: Record<string, unknown> = {}): PresetDoc =>
  importStPreset(JSON.stringify({ frequency_penalty: 0, group_nudge_prompt: "", ...fields })).document!

const at = (depth: number | null, data: StateEventData): PositionedEvent => ({ depth, event: { scope: null, data } })
const on = (...notes: ReadonlyArray<string>) =>
  notes.map((note) => at(null, { key: "note.activate", value: { note: note as never } }))
const muted = (entity: string, depth: number | null = null) =>
  at(depth, { key: "presence.set", value: { entity: entity as never, present: false } })

/** Aria and Bram take turns; the user plays Tobin. */
const chat = (fields: Partial<AssemblyFixture> = {}): AssemblyFixture => ({
  messages: [
    { side: "assistant", content: "The harbour is quiet.", speaker: "aria" },
    { side: "user", content: "Any ships?" }
  ],
  cards: [
    { entity: "aria", doc: cardDoc("Aria", { description: "{{char}} keeps the lighthouse." }) },
    { entity: "bram", doc: cardDoc("Bram", { description: "{{char}} mends nets." }) },
    { entity: "tobin", doc: cardDoc("Tobin", { description: "{{user}} sails." }) },
    { entity: "cato", doc: cardDoc("Cato") }
  ],
  participants: ["aria", "bram"],
  persona: "tobin",
  preset: preset(),
  model,
  ...fields
})

const chatNote = (entity: string, content: string, fields: Partial<NoteDoc> = {}): NoteInput => ({
  entity,
  revision: `${entity}-revision`,
  doc: {
    schema_version: 1,
    title: entity,
    content,
    placement: { mode: "section", section: "tail_end", role: "system" },
    owner: { chat: "chat-1" as never },
    exportable: false,
    ...fields
  }
})

const assembled = (fixture: AssemblyFixture) => Effect.runPromise(assembleFixture(fixture))
const contents = (snapshot: ContextSnapshot) => snapshot.request.messages.map((m) => m.content)
const sends = (snapshot: ContextSnapshot, text: string) => contents(snapshot).some((c) => c.includes(text))
const decision = (snapshot: ContextSnapshot, entity: string) => {
  const source = snapshot.pieces.find((p) => p.id === `note:${entity}`)?.source
  return source?.kind === "note" ? source.activation : null
}

describe("note positions (DESIGN §4.1)", () => {
  // A preset with a long tail after the history, and the same with the newest message moved after it.
  const tailed = (newestLast: boolean) => {
    const doc = preset({
      prompts: [
        { identifier: "main", role: "system", content: "MAIN", system_prompt: true },
        { identifier: "tail1", role: "system", content: "TAIL ONE", system_prompt: false },
        { identifier: "tail2", role: "system", content: "TAIL TWO", system_prompt: false }
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "charDescription", enabled: true },
            { identifier: "chatHistory", enabled: true },
            { identifier: "tail1", enabled: true },
            { identifier: "tail2", enabled: true }
          ]
        }
      ]
    })
    if (!newestLast) return doc
    // The preset editor's "newest message" marker moved after the tail.
    const order = doc.order.filter((entry) => entry.identifier !== "newestMessage")
    return { ...doc, order: [...order, { identifier: "newestMessage", enabled: true }] }
  }
  const placements: ReadonlyArray<readonly [string, NoteDoc["placement"]]> = [
    ["context_start", { mode: "section", section: "context_start", role: "system" }],
    ["after_main", { mode: "section", section: "after_main_prompt", role: "system" }],
    ["depth", { mode: "depth", depth: 1, role: "system" }],
    ["tail_start", { mode: "section", section: "tail_start", role: "system" }],
    ["tail_end", { mode: "section", section: "tail_end", role: "system" }]
  ]
  for (const newestLast of [false, true]) {
    it(`puts each of the five where it says, the newest message ${newestLast ? "after" : "before"} the tail`, async () => {
      const snapshot = await assembled(
        chat({
          preset: tailed(newestLast),
          notes: placements.map(([name, placement]) => chatNote(name, `NOTE ${name}`, { placement })),
          events: on(...placements.map(([name]) => name))
        })
      )
      const sent = contents(snapshot)
      const index = (text: string) => sent.findIndex((c) => c.includes(text))
      const [start, afterMain, depth, tailStart, tailEnd] = placements.map(([name]) => index(`NOTE ${name}`)) as [
        number,
        number,
        number,
        number,
        number
      ]
      const main = index("MAIN")
      const description = index("keeps the lighthouse")
      const earlier = index("The harbour is quiet.")
      const newest = index("Any ships?")
      const [one, two] = [index("TAIL ONE"), index("TAIL TWO")]
      expect([start, afterMain, depth, tailStart, tailEnd].every((i) => i >= 0)).toBe(true)
      expect(start).toBe(0)
      expect(main).toBeLessThan(afterMain)
      expect(afterMain).toBeLessThan(description)
      // Depth 1: before the newest message, after the one before it.
      expect(depth).toBeGreaterThan(earlier)
      expect(depth).toBeLessThan(newest)
      expect(tailStart).toBeLessThan(one)
      expect(one).toBeLessThan(two)
      // The end of the tail: the last thing before the newest message, or the very end when
      // the preset puts the newest message earlier.
      if (newestLast) {
        expect(tailEnd).toBeGreaterThan(two)
        expect(tailEnd).toBeLessThan(newest)
      } else {
        expect(newest).toBeLessThan(tailStart)
        expect(tailEnd).toBe(sent.length - 1)
      }
    })
  }
})

describe("note conditions (DESIGN §4.1)", () => {
  const turn = chatNote("turn", "ARIA'S OUTFIT", { condition: { when: "turn", card: "aria" as never } })

  it("sends a note on a card's turn only, the swipe's speaker included", async () => {
    const aria = await assembled(chat({ notes: [turn], events: on("turn"), target: { speaker: "aria" } }))
    expect(sends(aria, "ARIA'S OUTFIT")).toBe(true)
    expect(decision(aria, "turn")).toMatchObject({ condition: "on Aria's turn", due: true })
    const bram = await assembled(chat({ notes: [turn], events: on("turn"), target: { speaker: "bram" } }))
    expect(sends(bram, "ARIA'S OUTFIT")).toBe(false)
    expect(decision(bram, "turn")).toMatchObject({ condition: "on Aria's turn", due: false })
    // Another version of Aria's message is still Aria's turn; of Bram's, still not.
    for (const [speaker, sent] of [
      ["aria", true],
      ["bram", false]
    ] as const) {
      const swipe = await assembled(chat({ notes: [turn], events: on("turn"), target: { speaker, ordinal: 1 } }))
      expect(sends(swipe, "ARIA'S OUTFIT")).toBe(sent)
    }
    // The user writing as Tobin is Tobin's turn (owner question 8).
    const tobin = chatNote("tobin", "TOBIN'S HAT", { condition: { when: "turn", card: "tobin" as never } })
    const impersonated = await assembled(chat({ notes: [tobin], events: on("tobin"), target: { speaker: "tobin" } }))
    expect(sends(impersonated, "TOBIN'S HAT")).toBe(true)
  })

  it("sends a note while a card isn't muted, reading the mute at the leaf", async () => {
    const present = chatNote("present", "BRAM IS HERE", { condition: { when: "not_muted", card: "bram" as never } })
    const unmuted = await assembled(chat({ notes: [present], events: on("present") }))
    expect(sends(unmuted, "BRAM IS HERE")).toBe(true)
    const silenced = await assembled(chat({ notes: [present], events: [...on("present"), muted("bram", 1)] }))
    expect(sends(silenced, "BRAM IS HERE")).toBe(false)
    expect(decision(silenced, "present")).toMatchObject({ condition: "while Bram isn't muted", due: false })
    // Muting only stops a card talking: its card is still sent (DESIGN §3.5).
    expect(sends(silenced, "mends nets")).toBe(true)
  })

  it("holds neither condition for a card that isn't in the cast", async () => {
    const notes = [
      chatNote("cato-turn", "CATO TURN", { condition: { when: "turn", card: "cato" as never } }),
      chatNote("cato-here", "CATO HERE", { condition: { when: "not_muted", card: "cato" as never } })
    ]
    const snapshot = await assembled(chat({ notes, events: on("cato-turn", "cato-here") }))
    expect(sends(snapshot, "CATO TURN")).toBe(false)
    expect(sends(snapshot, "CATO HERE")).toBe(false)
  })

  it("expands a skipped note's macros nowhere: no variable it would set is set", async () => {
    const writer = chatNote("writer", "{{setvar::mood::grim}}MOOD", {
      condition: { when: "turn", card: "bram" as never }
    })
    const snapshot = await assembled(chat({ notes: [writer], events: on("writer"), target: { speaker: "aria" } }))
    expect(snapshot.effects).toEqual([])
    expect(sends(snapshot, "MOOD")).toBe(false)
  })

  it("fills {{summary}} from a summary note only when it's due, as it sends it", async () => {
    const summary = chatNote("summary", "THE STORY SO FAR", {
      kind: "imported_summary",
      placement: { mode: "none" },
      condition: { when: "turn", card: "aria" as never }
    })
    const story = preset({
      prompts: [{ identifier: "main", role: "system", content: "MAIN [{{summary}}]", system_prompt: true }]
    })
    const fixture = (speaker: string) =>
      chat({ preset: story, notes: [summary], events: on("summary"), target: { speaker } })
    const aria = await assembled(fixture("aria"))
    expect(sends(aria, "MAIN [THE STORY SO FAR]")).toBe(true)
    expect(aria.summaryFill).toMatchObject({ kind: "notes", count: 1 })
    const bram = await assembled(fixture("bram"))
    expect(sends(bram, "MAIN []")).toBe(true)
    expect(bram.summaryFill).toMatchObject({ kind: "none", count: 0 })
  })
})

describe("conditioned notes and the cache (DESIGN §4.1, §5.5)", () => {
  const longHistory = Array.from({ length: 12 }, (_, i) => ({
    side: i % 2 ? ("assistant" as const) : ("user" as const),
    content: `Turn ${i}: ${"waves ".repeat(20)}`,
    ...(i % 2 ? { speaker: i % 4 === 1 ? "aria" : "bram" } : {})
  }))
  const prefix = (snapshot: ContextSnapshot) => {
    const end = Math.max(-1, ...snapshot.request.breakpoints.map((b) => b.message))
    return snapshot.request.messages.slice(0, end + 1)
  }
  const turns = (placement: NoteDoc["placement"]) =>
    Promise.all(
      (["aria", "bram"] as const).map((speaker) =>
        assembled(
          chat({
            messages: longHistory,
            notes: [
              chatNote("turn", "ON ARIA'S TURN", { placement, condition: { when: "turn", card: "aria" as never } })
            ],
            events: on("turn"),
            target: { speaker }
          })
        )
      )
    )

  it("keeps the cached prefix across turns for a conditioned note at the tail", async () => {
    const [aria, bram] = (await turns({ mode: "section", section: "tail_end", role: "system" })) as [
      ContextSnapshot,
      ContextSnapshot
    ]
    expect(sends(aria, "ON ARIA'S TURN")).toBe(true)
    expect(sends(bram, "ON ARIA'S TURN")).toBe(false)
    expect(prefix(aria).length).toBeGreaterThan(0)
    expect(prefix(aria)).toEqual(prefix(bram))
  })

  it("ends the cached prefix before a conditioned note placed above the history", async () => {
    const [aria, bram] = (await turns({ mode: "section", section: "after_main_prompt", role: "system" })) as [
      ContextSnapshot,
      ContextSnapshot
    ]
    const note = contents(aria).findIndex((c) => c.includes("ON ARIA'S TURN"))
    expect(note).toBeGreaterThan(0)
    // Nothing at or after it is in the prefix either turn shares.
    for (const snapshot of [aria, bram]) expect(snapshot.request.breakpoints.every((b) => b.message < note)).toBe(true)
    // The same note always on is cached with the rest of the preset's part.
    const always = await assembled(
      chat({
        messages: longHistory,
        notes: [chatNote("always", "ALWAYS", { placement: { mode: "section", section: "after_main_prompt" } })],
        events: on("always")
      })
    )
    const index = contents(always).findIndex((c) => c.includes("ALWAYS"))
    expect(always.request.breakpoints.some((b) => b.message >= index)).toBe(true)
  })
})

describe("the lorebook scan switch (DESIGN §4.1)", () => {
  const book = loreBook([loreEntry({ keys: ["lighthouse"], content: "LORE: the lamp is oil-fired." })])
  const fixture = (scan: boolean, notes: ReadonlyArray<NoteInput>) =>
    chat({
      messages: [{ side: "user", content: "Any ships?" }],
      cards: [
        { entity: "aria", doc: cardDoc("Aria") },
        { entity: "bram", doc: cardDoc("Bram") },
        { entity: "tobin", doc: cardDoc("Tobin") }
      ],
      lorebooks: [{ id: "book", entity: "book", revision: "book-rev", doc: book.document }],
      notes: notes.map((n) => (scan ? { ...n, doc: { ...n.doc, scan_lore: true } } : n)),
      events: [
        ...on(...notes.map((n) => n.entity)),
        at(null, { key: "lorebook.attach", value: { ref: "book" as never } })
      ]
    })

  it("lets entries trigger on a note's text only when it says so, wherever it's placed", async () => {
    // At depth 30, far beyond the scan depth: ST's addInject scans it whole anyway.
    const deep = chatNote("Harbour", "The lighthouse is dark tonight.", {
      placement: { mode: "depth", depth: 30, role: "system" }
    })
    const off = await assembled(fixture(false, [deep]))
    expect(sends(off, "LORE: the lamp")).toBe(false)
    const scanned = await assembled(fixture(true, [deep]))
    expect(sends(scanned, "LORE: the lamp")).toBe(true)
    const lore = scanned.pieces.find((p) => p.source.kind === "lorebook")!.source
    expect(lore.kind === "lorebook" && lore.activation).toMatchObject({
      status: "activated",
      why: { kind: "keys", primaryKey: "lighthouse", notes: ["Harbour"] }
    })
  })

  it("scans a card's note with {{char}} as the card, and a skipped note not at all", async () => {
    const card: NoteInput = {
      ...chatNote("Aria's", "{{char}} watches the lighthouse."),
      doc: { ...chatNote("x", "").doc, title: "Aria's", content: "{{char}} watches.", owner: { card: "aria" as never } }
    }
    const keyed = loreBook([loreEntry({ keys: ["Aria watches"], content: "LORE: Aria at the window." })])
    const snapshot = await assembled({
      ...fixture(true, [card]),
      lorebooks: [{ id: "book", entity: "book", revision: "book-rev", doc: keyed.document }]
    })
    expect(sends(snapshot, "LORE: Aria at the window.")).toBe(true)
    const skipped = chatNote("Skipped", "The lighthouse.", { condition: { when: "turn", card: "bram" as never } })
    const notDue = await assembled({ ...fixture(true, [skipped]), target: { speaker: "aria" } })
    expect(sends(notDue, "LORE: the lamp")).toBe(false)
  })
})

describe("on in every chat (DESIGN §4.1)", () => {
  const cardNote = (entity: string, content: string, fields: Partial<NoteDoc> = {}): NoteInput => ({
    entity,
    revision: `${entity}-revision`,
    doc: {
      schema_version: 1,
      title: entity,
      content,
      placement: { mode: "depth", depth: 0, role: "system" },
      owner: { card: "aria" as never },
      exportable: true,
      ...fields
    }
  })

  it("puts a card's note marked so on without the chat, and no other: the first note isn't special", async () => {
    const first = cardNote("first", "FIRST NOTE")
    const later = cardNote("later", "ON EVERYWHERE", { on_by_default: true })
    const snapshot = await assembled(chat({ notes: [first, later] }))
    expect(sends(snapshot, "FIRST NOTE")).toBe(false)
    expect(sends(snapshot, "ON EVERYWHERE")).toBe(true)
    expect(decision(snapshot, "later")).toMatchObject({ activation: "default", due: true })
    // A chat switches it off like any note.
    const off = await assembled(
      chat({ notes: [later], events: [at(null, { key: "note.deactivate", value: { note: "later" as never } })] })
    )
    expect(sends(off, "ON EVERYWHERE")).toBe(false)
    // A chat's own note is never on by itself, whatever it says.
    const own = chatNote("own", "CHAT OWN", { on_by_default: true })
    expect(sends(await assembled(chat({ notes: [own] })), "CHAT OWN")).toBe(false)
  })

  it("sends nothing of a slot whose shared note is in the bin", async () => {
    const linked: NoteInput = {
      ...chatNote("slot", "OWN TEXT", { link: "shared" as never }),
      link: { entity: "shared", revision: null }
    }
    expect(sends(await assembled(chat({ notes: [linked], events: on("slot") })), "OWN TEXT")).toBe(false)
  })
})
