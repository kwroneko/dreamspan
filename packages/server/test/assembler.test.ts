// The context assembler's pipeline over in-memory chats (ARCHITECTURE §15). What ST would
// send for a preset is checked against ST itself by `npm run test:st`; these pin the rest:
// macros by source, rebuilding, notes, the budget, prefill, breakpoints and our layouts.
import type { EntityId } from "@rp/shared/chat.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { NoteDoc } from "@rp/shared/docs/note.ts"
import type { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { PositionedEvent } from "../src/assembler/pipeline.ts"
import type { ContextSnapshot, ModelInput, NoteInput } from "../src/assembler/types.ts"
import { matchLorebooks } from "../src/assembler/lorebook.ts"
import { chatCompletionsFields, providerRequest } from "../src/assembler/wire.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { forbidCardOverrides, importStPreset } from "../src/formats/preset.ts"
import { placeBreakpoints } from "../src/assembler/breakpoints.ts"
import type { Stability } from "../src/assembler/st.ts"
import { charDefinitions } from "@rp/shared/presetOrder.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { json, run } from "./formats/support.ts"
import { type AssemblyFixture, assembleFixture, type FixtureMessage } from "./support/assemblySources.ts"

const card = (name: string, fields: Partial<Record<keyof CardDoc, unknown>> = {}): CardDoc =>
  run(
    importCard(
      json({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name,
          description: "",
          personality: "",
          scenario: "",
          first_mes: "",
          mes_example: "",
          system_prompt: "",
          post_history_instructions: "",
          creator_notes: "",
          tags: [],
          creator: "",
          character_version: "",
          alternate_greetings: [],
          extensions: {},
          ...fields
        }
      })
    )
  ).card

const presetFile = (name: string) =>
  importStPreset(readFileSync(new URL(`fixtures/presets/${name}.json`, import.meta.url), "utf8")).document!

/**
 * ST's default preset with these fields changed (ST's names, as a preset file has them). Its
 * group nudge is off unless a test names it: it's a prompt after the history, sent whenever
 * the model writes as a character (DESIGN §2.2), which the tests of other things don't read.
 */
const preset = (fields: Record<string, unknown> = {}): PresetDoc =>
  importStPreset(JSON.stringify({ frequency_penalty: 0, group_nudge_prompt: "", ...fields })).document!

/** ST's single-character output: the per-field markers without the join wrapper. */
const unwrapped = (doc: PresetDoc): PresetDoc => ({
  ...doc,
  utility_prompts: { ...doc.utility_prompts, card_join_prefix: "", card_join_suffix: "" }
})

/** The whole-card Definitions marker in the order, before `before` (or in place of the per-field markers). */
const withDefinitions = (doc: PresetDoc, before = "charDescription"): PresetDoc => {
  const at = doc.order.findIndex((e) => e.identifier === before)
  return {
    ...doc,
    prompts: [...doc.prompts, charDefinitions],
    order: [...doc.order.slice(0, at), { identifier: "charDefinitions", enabled: true }, ...doc.order.slice(at)]
  }
}

/** Lorebook entries where their positions say, as ST places them. */
const loreByPosition = {
  depth: null,
  event: { scope: null, data: { key: "lorebook.below_history", value: { on: false } } }
} as const

const model = (fields: Partial<ModelInput> = {}): ModelInput => ({
  connectionId: "connection",
  modelId: "model",
  kind: "openai-chat",
  api: "openai-completions",
  key: "test-model",
  prefill: "none",
  cacheBreakpoints: "auto",
  context: null,
  presetOverride: null,
  ...fields
})

const mira = card("Mira", {
  description: "{{char}} keeps the ledger for {{user}}.",
  personality: "Exact.",
  scenario: "A flood."
})
const oren = card("Oren", {
  description: "{{char}} runs the ferry.",
  mes_example: "<START>\n{{user}}: Hi\n{{char}}: Closed."
})
const tobin = card("Tobin", { description: "{{user}} draws maps." })

const chat = (fields: Partial<AssemblyFixture> = {}): AssemblyFixture => ({
  messages: [
    { side: "assistant", content: "You're late." },
    { side: "user", content: "The road flooded." }
  ],
  cards: [
    { entity: "mira", doc: mira },
    { entity: "oren", doc: oren },
    { entity: "tobin", doc: tobin }
  ],
  participants: ["mira"],
  persona: "tobin",
  preset: preset(),
  model: model(),
  ...fields
})

const assembled = (fixture: AssemblyFixture, options?: Parameters<typeof assembleFixture>[1]) =>
  Effect.runPromise(assembleFixture(fixture, options))

const contents = (snapshot: ContextSnapshot) => snapshot.request.messages.map((m) => `${m.role}: ${m.content}`)

/** A prompt-only regex script on the model's messages, as ST's preset file has it. */
const regexScript = (id: string, fields: Record<string, unknown>) => ({
  id,
  scriptName: id,
  replaceString: "",
  trimStrings: [],
  placement: [2],
  disabled: false,
  markdownOnly: false,
  promptOnly: true,
  runOnEdit: false,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
  ...fields
})

const at = (depth: number | null, data: StateEventData): PositionedEvent => ({ depth, event: { scope: null, data } })

const note = (content: string, depth: number, role: "system" | "user" | "assistant", first = true): NoteInput => ({
  entity: `note-${content.length}`,
  revision: "note-revision",
  first,
  doc: {
    schema_version: 1,
    title: "Character's Note",
    content,
    placement: { mode: "depth", depth, role },
    owner: { card: "mira" as never },
    exportable: true,
    ...(first ? { on_by_default: true } : {})
  }
})

describe("the context assembler", () => {
  it("lays out ST's default preset for one character as ST does, without the join wrapper", async () => {
    const snapshot = await assembled(chat({ preset: unwrapped(presetFile("default")) }))
    expect(contents(snapshot)).toEqual([
      "system: You narrate a story starring Mira and Tobin.",
      "system: Tobin draws maps.",
      "system: Mira keeps the ledger for Tobin.",
      "system: Exact.",
      "system: A flood.",
      "system: [A new story begins]",
      "assistant: You're late.",
      "user: The road flooded.",
      // The group nudge is sent whenever the model writes as a character, one or many (DESIGN §2.2).
      "system: [Only Mira speaks next.]"
    ])
    expect(snapshot.inputs.mode).toBe("layouts")
    const wrapped = await assembled(chat({ preset: presetFile("default") }))
    expect(contents(wrapped).slice(2, 5)).toEqual([
      "system: <Mira>\nMira keeps the ledger for Tobin.\n</Mira>",
      "system: <Mira>\nExact.\n</Mira>",
      "system: <Mira>\nA flood.\n</Mira>"
    ])
    // Every piece names where it came from and which message it went into.
    const description = snapshot.pieces.find((p) => p.id === "card:mira:description")!
    expect(description.source).toEqual({ kind: "card", entity: "mira", revision: "rev-mira", field: "description" })
    expect(description.messages).toEqual([2])
  })

  it("expands card and preset text, and a message only when it's a template (DESIGN §5.6)", async () => {
    const snapshot = await assembled(
      chat({
        messages: [
          { side: "assistant", content: "*{{char}} waves at {{user}}.* {{getvar::x}}", macroMode: "template" },
          { side: "user", content: "I typed {{char}} myself." }
        ],
        events: [
          at(null, { key: "var.set", value: { name: "x", value: 1 } }),
          at(0, { key: "var.set", value: { name: "x", value: 2 } })
        ],
        preset: preset({ prompts: [{ identifier: "main", role: "system", content: "x is {{getvar::x}}" }] })
      })
    )
    const messages = contents(snapshot)
    // The greeting sees the state before its own events; the preset, the state after them.
    expect(messages).toContain("assistant: *Mira waves at Tobin.* 1")
    expect(messages).toContain("system: x is 2")
    expect(messages).toContain("user: I typed {{char}} myself.")
  })

  it("expands a template message with the cast, names and card it had at its position", async () => {
    const greeting = {
      side: "assistant",
      content: "{{char}} greets {{user}}: {{description}}",
      macroMode: "template"
    } as const
    const snapshot = await assembled(
      chat({
        messages: [greeting, { side: "user", content: "Hi." }],
        // After the greeting, Oren takes Mira's place, and {{user}} is pinned.
        events: [
          at(0, { key: "participant.leave", value: { entity: "mira" as EntityId } }),
          at(0, { key: "participant.join", value: { entity: "oren" as EntityId } }),
          at(0, { key: "macro.binding", value: { name: "user", value: "Captain" } })
        ]
      })
    )
    expect(contents(snapshot)).toContain("assistant: Mira greets Tobin: Mira keeps the ledger for Tobin.")
    expect(contents(snapshot)).toContain("user: Hi.")
  })

  it("records the variables macros write, and later pieces read them", async () => {
    const snapshot = await assembled(
      chat({
        preset: preset({
          prompts: [
            { identifier: "main", role: "system", content: "{{setvar::mood::calm}}Begin." },
            { identifier: "nsfw", role: "system", content: "Mood: {{getvar::mood}}" }
          ]
        })
      })
    )
    expect(contents(snapshot)).toContain("system: Mood: calm")
    expect(snapshot.effects).toEqual([{ scope: "local", name: "mood", value: "calm" }])
  })

  it("keeps what a template message writes the first time it expands, for what comes after it", async () => {
    // Frozen when its chat was made, as every greeting is, but its writes not recorded yet.
    const fixture = (written: boolean) =>
      chat({
        messages: [
          {
            side: "assistant",
            content: "{{setvar::mood::grim}}Late again.",
            macroMode: "template",
            frozen: {},
            written
          },
          { side: "user", content: "Sorry." },
          { side: "assistant", content: "Mood: {{getvar::mood}}.", macroMode: "template" }
        ],
        preset: preset({ prompts: [{ identifier: "main", role: "system", content: "Now {{getvar::mood}}." }] })
      })
    const first = await assembled(fixture(false))
    expect(contents(first)).toContain("assistant: Mood: grim.")
    expect(contents(first)).toContain("system: Now grim.")
    expect(first.templateWrites).toEqual([
      { version: "version-0", writes: [{ scope: "local", name: "mood", value: "grim" }] }
    ])
    // Recorded before, its writes are state events by now, and aren't written twice.
    const again = await assembled(fixture(true))
    expect(again.templateWrites).toEqual([])
  })

  it("builds the same context again from the values drawn the first time (invariant 6)", async () => {
    const fixture = chat({
      preset: preset({
        prompts: [{ identifier: "main", role: "system", content: "{{random::a::b::c::d}} {{roll::1d1000}}" }]
      })
    })
    const first = await assembled(fixture, { random: Math.random })
    const again = await assembled(fixture, { frozen: first.frozen, random: () => 0.999 })
    expect(again.request).toEqual(first.request)
    expect(Object.keys(first.frozen)).toEqual(["preset:main"])
  })

  it("leaves out a piece whose macros reach a limit, and says which", async () => {
    const snapshot = await assembled(
      chat({ preset: preset({ prompts: [{ identifier: "main", role: "system", content: "x".repeat(300_000) }] }) })
    )
    expect(contents(snapshot)[0]).not.toContain("xxx")
    expect(snapshot.issues).toEqual([expect.objectContaining({ kind: "macro_limit" })])
    expect(snapshot.issues[0]!.message).toContain("preset:main")
  })

  it("injects the Character's Note at its depth and role, unless the chat turned it off", async () => {
    const characterNote = note("{{char}} never guesses.", 1, "user")
    const on = await assembled(chat({ notes: [characterNote] }))
    expect(contents(on).slice(-3)).toEqual([
      "assistant: You're late.",
      "user: Mira never guesses.",
      "user: The road flooded."
    ])
    const off = await assembled(
      chat({
        notes: [characterNote],
        events: [at(null, { key: "note.deactivate", value: { note: characterNote.entity as never } })]
      })
    )
    expect(contents(off).join("\n")).not.toContain("never guesses")
    // A card's other notes are off until the chat turns them on.
    const other = { ...note("{{char}} wears blue.", 0, "system", false), entity: "note-other" }
    const quiet = await assembled(chat({ notes: [other] }))
    expect(contents(quiet).join("\n")).not.toContain("wears blue")
    const active = await assembled(
      chat({ notes: [other], events: [at(null, { key: "note.activate", value: { note: "note-other" as never } })] })
    )
    expect(contents(active).at(-1)).toBe("system: Mira wears blue.")
  })

  it("sends an imported summary as ST's Summarize extension did (DESIGN §8.1)", async () => {
    const summary = (placement: NoteDoc["placement"], template = "[Summary: {{summary}}]"): NoteInput => ({
      entity: "note-summary",
      revision: "summary-revision",
      first: false,
      doc: {
        schema_version: 1,
        title: "Summary",
        content: "  {{char}} lost the ledger in the flood.  ",
        placement,
        owner: { chat: "chat-1" as never },
        exportable: true,
        kind: "imported_summary",
        template
      }
    })
    const on = at(null, { key: "note.activate", value: { note: "note-summary" as never } })
    // The run it covers stays hidden: only what ST sent goes.
    const imported = (placement: NoteDoc["placement"], fields: Partial<AssemblyFixture> = {}, template?: string) =>
      assembled(
        chat({
          messages: [
            { side: "assistant", content: "Covered.", inContext: false },
            { side: "user", content: "Also covered.", inContext: false },
            { side: "assistant", content: "You're late." },
            { side: "user", content: "The road flooded." }
          ],
          notes: [summary(placement, template)],
          events: [on],
          ...fields
        })
      )
    const inChat = await imported({ mode: "depth", depth: 1, role: "system" }, { notes: [] })
    expect(contents(inChat).join("\n")).not.toContain("lost the ledger")
    const depth = await imported(
      { mode: "depth", depth: 1, role: "system" },
      { notes: [summary({ mode: "depth", depth: 1, role: "system" }), note("{{char}} never guesses.", 1, "system")] }
    )
    expect(contents(depth).slice(-3)).toEqual([
      "assistant: You're late.",
      // The extension's prompt comes before the Character's Note, in ST's key order.
      "system: [Summary: Mira lost the ledger in the flood.]\nMira never guesses.",
      "user: The road flooded."
    ])
    expect(contents(depth).join("\n")).not.toContain("covered")
    const main = "system: Write Mira's next reply in a fictional chat between Mira and Tobin."
    const after = await imported({ mode: "section", section: "after_main_prompt" }, {}, "")
    expect(contents(after).slice(0, 2)).toEqual([main, "system: Summary: Mira lost the ledger in the flood."])
    const before = await imported({ mode: "section", section: "before_main_prompt" })
    expect(contents(before).slice(0, 2)).toEqual(["system: [Summary: Mira lost the ledger in the flood.]", main])
    // Placed nowhere, it's still what {{summary}} reads; off, it isn't sent.
    const macro = await imported(
      { mode: "none" },
      { preset: preset({ prompts: [{ identifier: "main", role: "system", content: "Story so far: {{summary}}" }] }) }
    )
    expect(contents(macro)[0]).toMatch(/^system: Story so far: .* lost the ledger in the flood\./)
    // With the card's definition there is no card to put a chat's note with; at the author's
    // note's top or bottom it joins the default note a chat without one has.
    expect(contents(await imported({ mode: "section", section: "card" })).join("\n")).not.toContain("lost the ledger")
    for (const section of ["author_note_top", "author_note_bottom"] as const) {
      expect(contents(await imported({ mode: "section", section })).join("\n")).toContain("lost the ledger")
    }
    const off = await imported({ mode: "section", section: "after_main_prompt" }, { events: [] })
    expect(contents(off).join("\n")).not.toContain("lost the ledger")
  })

  describe("the chat's own notes", () => {
    const chatNote = (
      entity: string,
      content: string,
      placement: NoteDoc["placement"],
      fields: Partial<NoteDoc> = {}
    ): NoteInput => ({
      entity,
      revision: `${entity}-revision`,
      first: false,
      doc: {
        schema_version: 1,
        title: entity,
        content,
        placement,
        owner: { chat: "chat-1" as never },
        exportable: false,
        ...fields
      }
    })
    const on = (...notes: ReadonlyArray<string>) =>
      notes.map((note) => at(null, { key: "note.activate", value: { note: note as never } }))
    const authorNote = (placement: NoteDoc["placement"], fields: Partial<NoteDoc> = {}) =>
      chatNote("note-z-author", "{{user}} is soaked.", placement, { kind: "author_note", ...fields })
    const main = "system: Write Mira's next reply in a fictional chat between Mira and Tobin."
    // A condition that never holds here (Oren isn't in the cast), and a group whose turns
    // alternate a note on Mira's turn between due (Mira speaks) and not (Oren does).
    const never = { condition: { when: "turn", card: "oren" } } as Partial<NoteDoc>
    const onMirasTurn = { condition: { when: "turn", card: "mira" } } as Partial<NoteDoc>
    const turnOf = (due: boolean): Partial<AssemblyFixture> => ({
      participants: ["mira", "oren"],
      target: { speaker: due ? "mira" : "oren" }
    })

    it("sends one once the chat turns it on, with the chat's bindings", async () => {
      const scene = chatNote("note-scene", "{{char}} and {{user}} wait out the storm.", {
        mode: "depth",
        depth: 1,
        role: "user"
      })
      const off = await assembled(chat({ notes: [scene] }))
      expect(contents(off).join("\n")).not.toContain("storm")
      const sent = await assembled(chat({ notes: [scene], events: on("note-scene") }))
      expect(contents(sent).slice(-3)).toEqual([
        "assistant: You're late.",
        "user: Mira and Tobin wait out the storm.",
        "user: The road flooded."
      ])
      expect(sent.pieces.find((p) => p.id === "note:note-scene")?.source).toEqual({
        kind: "note",
        entity: "note-scene",
        revision: "note-scene-revision",
        activation: { kind: "note", activation: "explicit", interval: null, userMessages: null, due: true }
      })
      const stashed = await assembled(
        chat({
          notes: [scene],
          events: [...on("note-scene"), at(1, { key: "note.deactivate", value: { note: "note-scene" as never } })]
        })
      )
      expect(contents(stashed).join("\n")).not.toContain("storm")
    })

    it("puts the author's note after the summary and before the cards' notes, as ST orders its extension prompts", async () => {
      const summary = chatNote(
        "note-0-summary",
        "The ledger is lost.",
        { mode: "depth", depth: 1, role: "system" },
        {
          kind: "imported_summary",
          template: "[{{summary}}]"
        }
      )
      const other = chatNote("note-a-other", "Thunder.", { mode: "depth", depth: 1, role: "system" })
      const snapshot = await assembled(
        chat({
          notes: [
            note("{{char}} never guesses.", 1, "system"),
            other,
            authorNote({ mode: "depth", depth: 1, role: "system" }),
            summary
          ],
          events: on("note-0-summary", "note-a-other", "note-z-author")
        })
      )
      expect(contents(snapshot).slice(-2)).toEqual([
        "system: [The ledger is lost.]\nTobin is soaked.\nThunder.\nMira never guesses.",
        "user: The road flooded."
      ])
    })

    it("names the author's note by its state event as well as by its kind", async () => {
      const plain = chatNote("note-z-plain", "Last.", { mode: "depth", depth: 0, role: "system" })
      const named = chatNote("note-zz-named", "First.", { mode: "depth", depth: 0, role: "system" })
      const snapshot = await assembled(
        chat({
          notes: [plain, named],
          events: [
            ...on("note-z-plain", "note-zz-named"),
            at(null, { key: "author_note.set", value: { note: "note-zz-named" as never } })
          ]
        })
      )
      expect(contents(snapshot).at(-1)).toBe("system: First.\nLast.")
    })

    it("puts a note at the tail at depth 0, with its role", async () => {
      const snapshot = await assembled(
        chat({ notes: [authorNote({ mode: "tail", role: "assistant" })], events: on("note-z-author") })
      )
      // The chat ends on the user's message, so nothing is added after the assistant note
      // (owner 2026-10-28: the closing user turn only follows a chat that ends on the model's side).
      expect(contents(snapshot).slice(-2)).toEqual(["user: The road flooded.", "assistant: Tobin is soaked."])
      expect(snapshot.issues).toEqual([])
    })

    it("puts notes beside the main prompt in turn, as ST's injectToMain does", async () => {
      const summary = (section: "before_main_prompt" | "after_main_prompt") =>
        chatNote("note-0-summary", "The ledger is lost.", { mode: "section", section }, { kind: "imported_summary" })
      const after = await assembled(
        chat({
          notes: [summary("after_main_prompt"), authorNote({ mode: "section", section: "after_main_prompt" })],
          events: on("note-0-summary", "note-z-author")
        })
      )
      expect(contents(after).slice(0, 3)).toEqual([
        main,
        "system: Summary: The ledger is lost.",
        "system: Tobin is soaked."
      ])
      const before = await assembled(
        chat({
          notes: [summary("before_main_prompt"), authorNote({ mode: "section", section: "before_main_prompt" })],
          events: on("note-0-summary", "note-z-author")
        })
      )
      // Each goes in at the start in turn, so the author's note ends up first.
      expect(contents(before).slice(0, 3)).toEqual([
        "system: Tobin is soaked.",
        "system: Summary: The ledger is lost.",
        main
      ])
    })

    describe("a persona placed by its note (ARCHITECTURE §13)", () => {
      const persona = (placement: NoteDoc["placement"]): NoteInput => ({
        entity: "note-persona",
        revision: "note-persona-revision",
        first: true,
        doc: {
          schema_version: 1,
          title: "Persona description",
          content: "{{user}} draws maps.",
          placement,
          owner: { card: "tobin" as never },
          exportable: true,
          on_by_default: true,
          kind: "persona_description"
        }
      })
      const top = persona({ mode: "section", section: "author_note_top" })
      const bottom = persona({ mode: "section", section: "author_note_bottom" })
      const inChat = { mode: "depth", depth: 1, role: "system" } as const
      const sent = (snapshot: ContextSnapshot) => contents(snapshot).filter((line) => line.includes("draws maps"))

      it("sends it at the top or bottom of the author's note, and not where the persona goes", async () => {
        for (const [note, expected] of [
          [top, "system: Tobin draws maps.\nTobin is soaked."],
          [bottom, "system: Tobin is soaked.\nTobin draws maps."]
        ] as const) {
          const snapshot = await assembled(chat({ notes: [note, authorNote(inChat)], events: on("note-z-author") }))
          expect(sent(snapshot)).toEqual([expected])
          expect(contents(snapshot).slice(-2)).toEqual([expected, "user: The road flooded."])
        }
      })

      it("sends it beside the main prompt when the author's note goes there", async () => {
        const snapshot = await assembled(
          chat({
            notes: [bottom, authorNote({ mode: "section", section: "after_main_prompt", role: "user" })],
            events: on("note-z-author")
          })
        )
        expect(contents(snapshot).slice(0, 2)).toEqual([main, "user: Tobin is soaked.\nTobin draws maps."])
      })

      it("sends it with ST's default note, in-chat at depth 4, when the chat has none", async () => {
        const messages = [
          { side: "assistant", content: "One." },
          { side: "user", content: "Two." },
          { side: "assistant", content: "Three." },
          { side: "user", content: "Four." },
          { side: "assistant", content: "Five." },
          { side: "user", content: "Six." }
        ] as const
        for (const note of [top, bottom]) {
          const snapshot = await assembled(chat({ messages: [...messages], notes: [note] }))
          expect(contents(snapshot).slice(-5)).toEqual([
            "system: Tobin draws maps.",
            "assistant: Three.",
            "user: Four.",
            "assistant: Five.",
            "user: Six."
          ])
        }
      })

      it("sends nothing of it while the author's note is not due, and it alone where it sits while it's off", async () => {
        // Switched off, the note's text goes, but what rides on it doesn't (owner question 6).
        const off = await assembled(chat({ notes: [top, authorNote(inChat)] }))
        expect(sent(off)).toEqual(["system: Tobin draws maps."])
        expect(contents(off).join("\n")).not.toContain("soaked")
        const skipped = authorNote(inChat, never)
        expect(sent(await assembled(chat({ notes: [top, skipped], events: on("note-z-author") })))).toEqual([])
        const due = await assembled(
          chat({ notes: [top, authorNote(inChat, onMirasTurn)], events: on("note-z-author") })
        )
        expect(sent(due)).toEqual(["system: Tobin draws maps.\nTobin is soaked."])
      })

      {
        const layout = "the Definitions marker"
        for (const legacy of [false, true]) {
          const description = (placement: NoteDoc["placement"]) => {
            const note = persona(placement)
            if (!legacy) return note
            const { kind: _, ...doc } = note.doc
            return { ...note, doc }
          }
          it(`keeps a ${legacy ? "legacy" : "current"} persona description placed with its card in ${layout}`, async () => {
            const snapshot = await assembled(
              chat({
                notes: [description({ mode: "section", section: "card" })],
                preset: withDefinitions(preset())
              })
            )
            expect(sent(snapshot)).toEqual([
              'system: <character name="Mira">\nMira keeps the ledger for Tobin.\n\nExact.\n\nA flood.\n</character>\n\n<persona name="Tobin">\nTobin draws maps.\n</persona>'
            ])
            expect(contents(snapshot).join("\n").split("Tobin draws maps.")).toHaveLength(2)
          })
          it(`keeps ordinary card notes beside a relocated ${legacy ? "legacy" : "current"} persona in ${layout}`, async () => {
            const cardNote = persona({ mode: "section", section: "card" })
            const { kind: _, ...ordinaryDoc } = cardNote.doc
            const extra: NoteInput = {
              ...cardNote,
              entity: "ordinary-note",
              first: false,
              doc: {
                ...ordinaryDoc,
                title: "Scene",
                content: "ORDINARY_CARD_NOTE"
              }
            }
            const snapshot = await assembled(
              chat({
                notes: [description({ mode: "depth", depth: 0, role: "user" }), extra],
                events: on("ordinary-note"),
                preset: withDefinitions(preset())
              })
            )
            expect(sent(snapshot)).toEqual(["user: Tobin draws maps."])
            expect(contents(snapshot).filter((line) => line.includes("ORDINARY_CARD_NOTE"))).toEqual([
              'system: <character name="Mira">\nMira keeps the ledger for Tobin.\n\nExact.\n\nA flood.\n</character>\n\n<persona name="Tobin">\nORDINARY_CARD_NOTE\n</persona>'
            ])
            const empty = await assembled(
              chat({
                notes: [description({ mode: "depth", depth: 0, role: "user" })],
                preset: withDefinitions(preset())
              })
            )
            expect(contents(empty).join("\n")).not.toContain("<persona")
          })
        }
      }

      for (const layout of [null, "below the history"] as const) {
        for (const attachment of [top, bottom]) {
          it(`switching the author's note off leaves its attachments where it sits ${layout ?? "with lore by position"} at ${attachment.doc.placement.mode === "section" ? attachment.doc.placement.section : ""}`, async () => {
            const book = loreBook([
              loreEntry({ content: "LORE_TOP", constant: true, position: "an_top" }, 0),
              loreEntry({ content: "LORE_BOTTOM", constant: true, position: "an_bottom" }, 1)
            ])
            const fixture = (switched: boolean) =>
              chat({
                notes: [attachment, authorNote(inChat)],
                // Below the history all lore is at the tail; by position, these entries ride on the note.
                lorebooks: layout ? [] : [{ id: "book", entity: "book", revision: "book-rev", doc: book.document }],
                events: [
                  ...on("note-z-author"),
                  at(null, { key: "lorebook.attach", value: { ref: "book" as never } }),
                  ...(layout ? [] : [loreByPosition]),
                  ...(switched ? [at(1, { key: "note.deactivate", value: { note: "note-z-author" as never } })] : [])
                ]
              })
            expect(sent(await assembled(fixture(false)))).toHaveLength(1)
            const snapshot = await assembled(fixture(true))
            const text = contents(snapshot).join("\n")
            expect(text).toContain("draws maps")
            expect(text).not.toContain("is soaked")
            // By position the lore rides on the note too; below the history it is at the tail anyway.
            if (!layout) {
              expect(text).toContain("LORE_TOP")
              expect(text).toContain("LORE_BOTTOM")
            }
            // Not due by its condition, nothing rides on it, as ST's skipped turn.
            const skipped = await assembled({
              ...fixture(false),
              notes: [attachment, authorNote(inChat, never)]
            })
            const none = contents(skipped).join("\n")
            expect(none).not.toContain("draws maps")
            expect(none).not.toContain("LORE_TOP")
          })
        }
      }

      it("joins the author's note as one piece of the context", async () => {
        // The lore comes with the other tests; here only that the persona is outside the note.
        const snapshot = await assembled(chat({ notes: [top, authorNote(inChat)], events: on("note-z-author") }))
        expect(snapshot.pieces.some((p) => p.id === "lore:author-note")).toBe(true)
      })

      it("places it at depth or nowhere by its note, never also in the persona's description", async () => {
        const deep = await assembled(chat({ notes: [persona({ mode: "depth", depth: 0, role: "user" })] }))
        expect(sent(deep)).toEqual(["user: Tobin draws maps."])
        const none = await assembled(chat({ notes: [persona({ mode: "none" })] }))
        expect(sent(none)).toEqual([])
        const plain = await assembled(chat())
        expect(sent(plain)).toEqual(["system: Tobin draws maps."])
      })

      it("keeps a persona whose note isn't its description's placement in the prompt", async () => {
        const { kind: _, ...plain } = top.doc
        const other: NoteInput = { ...top, doc: { ...plain, title: "Scene", content: "Rain." } }
        const snapshot = await assembled(chat({ notes: [other] }))
        expect(sent(snapshot)).toEqual(["system: Tobin draws maps."])
      })
    })

    it("sends a note placed with the card's definition above it", async () => {
      const snapshot = await assembled(
        chat({
          notes: [
            {
              ...note("Tide tables.", 1, "system"),
              doc: { ...note("Tide tables.", 1, "system").doc, placement: { mode: "section", section: "card" } }
            }
          ]
        })
      )
      expect(contents(snapshot).filter((line) => line.includes("keeps the ledger"))).toEqual([
        "system: <Mira>\nTide tables.\nMira keeps the ledger for Tobin.\n</Mira>"
      ])
    })

    it("expands summaries after main writes, independently of placement order", async () => {
      for (const placement of [
        { mode: "depth", depth: 0, role: "system" },
        { mode: "section", section: "before_main_prompt" },
        { mode: "section", section: "after_main_prompt" }
      ] as const) {
        const snapshot = await assembled(
          chat({
            preset: preset({
              prompts: [{ identifier: "main", role: "system", content: "{{setvar::weather::RAIN}}MAIN" }]
            }),
            notes: [
              chatNote("summary", "A summary", placement, {
                kind: "imported_summary",
                template: "[{{summary}}; {{getvar::weather}}]"
              })
            ],
            events: on("summary")
          })
        )
        expect(contents(snapshot).join("\n")).toContain("[A summary; RAIN]")
      }
    })

    it("expands main, summary, author and other notes in dependency order regardless of placement", async () => {
      for (const placement of [
        { mode: "depth", depth: 0, role: "system" },
        { mode: "section", section: "before_main_prompt" },
        { mode: "section", section: "after_main_prompt" }
      ] as const) {
        const snapshot = await assembled(
          chat({
            preset: preset({ prompts: [{ identifier: "main", role: "system", content: "{{setvar::x::MAIN}}MAIN" }] }),
            notes: [
              chatNote("sum", "STORY", placement, {
                kind: "imported_summary",
                template: "{{getvar::x}}{{setvar::x::SUM}}{{summary}}"
              }),
              authorNote(placement, { content: "{{getvar::x}} is soaked through.{{setvar::x::AUTHOR}}" }),
              chatNote("other", "{{getvar::x}} follows.", placement)
            ],
            events: on("sum", "note-z-author", "other")
          })
        )
        expect(contents(snapshot).join("\n")).toContain("MAINSTORY")
        expect(contents(snapshot).join("\n")).toContain("SUM is soaked through.")
        expect(contents(snapshot).join("\n")).toContain("AUTHOR follows.")
      }
    })

    it("keeps skipped cache markers out of filler selection and role squashing", async () => {
      for (const target of [{}, { speaker: "tobin" }, { ordinal: 1 }]) {
        for (const role of ["system", "user", "assistant"] as const) {
          for (const placement of [
            { mode: "section", section: "after_main_prompt", role },
            { mode: "depth", depth: 0, role }
          ] as const) {
            const build = (fields: Partial<NoteDoc> | null) =>
              assembled(
                chat({
                  target,
                  messages: [
                    { side: "user", content: "USER" },
                    { side: "assistant", content: "REPLY" }
                  ],
                  preset: preset({
                    squash_system_messages: true,
                    send_if_empty: "FILLER",
                    prompts: [{ identifier: "main", role: "system", content: "MAIN" }]
                  }),
                  notes: [authorNote(placement, fields ?? {})],
                  events: fields ? on("note-z-author") : []
                })
              )
            const absent = await build(null)
            const skipped = await build(never)
            expect(skipped.request.messages, JSON.stringify({ target, placement })).toEqual(absent.request.messages)
            expect(skipped.request.breakpoints.length).toBeLessThanOrEqual(absent.request.breakpoints.length)
          }
        }
      }
    })

    it("bounds variable-dependent notes at their placement on both due and skipped turns", async () => {
      const snapshots = []
      for (const users of [1, 2]) {
        snapshots.push(
          await assembled(
            chat({
              ...turnOf(users === 2),
              messages: Array.from({ length: users }, (_, i) => ({ side: "user", content: `USER ${i}` })),
              preset: preset({ prompts: [{ identifier: "main", role: "system", content: "{{setvar::x::MAIN}}MAIN" }] }),
              notes: [
                authorNote({ mode: "tail", role: "system" }, { content: "WRITER{{setvar::x::DUE}}", ...onMirasTurn }),
                chatNote(
                  "card",
                  "PREFIX={{getvar::x}}",
                  { mode: "section", section: "before_main_prompt" },
                  { owner: { card: "mira" as never } }
                )
              ],
              events: on("note-z-author", "card")
            })
          )
        )
      }
      expect(snapshots.map((s) => s.request.messages[0]!.content)).toEqual(["PREFIX=MAIN", "PREFIX=DUE"])
      for (const snapshot of snapshots) expect(snapshot.request.breakpoints).toEqual([])
    })

    it("tracks variable reads through shorthand, aliases and nested macros without tracking names", async () => {
      for (const content of [
        "{{.x}}",
        "{{$g}}",
        "{{getglobalvar::g}}",
        "{{varexists::x}}",
        "{{getvarindex::obj::key}}",
        "{{if {{hasvar::x}}}}DUE{{/if}}",
        "{{getvar::unrelated}}",
        "{{getvar::x}}"
      ]) {
        for (const users of [1, 2]) {
          const snapshot = await assembled(
            chat({
              ...turnOf(users === 2),
              messages: Array.from({ length: users }, (_, i) => ({ side: "user", content: `USER ${i}` })),
              notes: [
                authorNote(
                  { mode: "tail", role: "system" },
                  { content: "{{setvar::x::DUE}}{{setglobalvar::g::DUE}}{{setvarkey::obj::key::DUE}}", ...onMirasTurn }
                ),
                chatNote("reader", content, { mode: "section", section: "before_main_prompt" })
              ],
              events: on("note-z-author", "reader")
            })
          )
          expect(snapshot.request.breakpoints, `${users}: ${content}`).toEqual([])
        }
      }
    })

    it("keeps earlier variable readers and later literals cacheable", async () => {
      for (const users of [1, 2]) {
        const snapshot = await assembled(
          chat({
            ...turnOf(users === 2),
            messages: Array.from({ length: users }, (_, i) => ({ side: "user", content: `USER ${i}` })),
            notes: [
              chatNote(
                "summary",
                "STORY",
                { mode: "section", section: "before_main_prompt" },
                { kind: "imported_summary", template: "{{getvar::x}} {{summary}}" }
              ),
              authorNote({ mode: "tail", role: "system" }, { content: "{{setvar::x::DUE}}", ...onMirasTurn }),
              chatNote("literal", "STATIC", { mode: "section", section: "before_main_prompt" })
            ],
            events: on("summary", "note-z-author", "literal")
          })
        )
        expect(snapshot.request.breakpoints.some((b) => b.reason === "prefix")).toBe(true)
      }
    })

    it("bounds later preset prompts that read intermittent variables, including empty expansion", async () => {
      for (const content of ["EXAMPLE={{getvar::x}}", "{{getvar::x}}"]) {
        for (const users of [1, 2]) {
          const snapshot = await assembled(
            chat({
              ...turnOf(users === 2),
              cards: [
                { entity: "mira", doc: card("Mira", { mes_example: "<START>\nTobin: Hello\nMira: Hi" }) },
                { entity: "oren", doc: card("Oren", { mes_example: "<START>\nTobin: Hello\nOren: Hi" }) },
                { entity: "tobin", doc: tobin }
              ],
              messages: Array.from({ length: users }, (_, i) => ({ side: "user", content: `USER ${i}` })),
              preset: preset({ new_example_chat_prompt: content }),
              notes: [authorNote({ mode: "tail", role: "system" }, { content: "{{setvar::x::DUE}}", ...onMirasTurn })],
              events: on("note-z-author")
            })
          )
          const example = snapshot.request.messages.findIndex((m) => m.name === "example_user")
          expect(example).toBeGreaterThan(0)
          const heading = snapshot.request.messages.findIndex(
            (m) => m.content === (users === 2 ? content.replace("{{getvar::x}}", "DUE") : "EXAMPLE=")
          )
          const boundary = heading < 0 ? example : heading
          expect(snapshot.request.breakpoints.every((b) => b.message < boundary)).toBe(true)
        }
      }
    })

    it("keeps a skipped conditioned note's potential cache boundary beside main", async () => {
      for (const section of ["before_main_prompt", "after_main_prompt"] as const) {
        for (const users of [1, 2]) {
          const snapshot = await assembled(
            chat({
              ...turnOf(users === 2),
              messages: Array.from({ length: users }, (_, i) => ({ side: "user", content: `USER ${i}` })),
              notes: [authorNote({ mode: "section", section }, onMirasTurn)],
              events: on("note-z-author")
            })
          )
          const marked = snapshot.request.breakpoints.map((b) => b.message)
          expect(marked).toEqual(section === "before_main_prompt" ? [] : [0])
          expect(contents(snapshot).join("\n").includes("soaked")).toBe(users === 2)
        }
      }
    })

    it("keeps skipped depth notes volatile without expanding their macros", async () => {
      const snapshot = await assembled(
        chat({
          messages: [{ side: "user", content: "USER" }],
          notes: [
            chatNote("depth", "{{setvar::skipped::BAD}}Note", { mode: "depth", depth: 1, role: "system" }, never)
          ],
          events: on("depth")
        })
      )
      expect(snapshot.effects).toEqual([])
      expect(snapshot.request.breakpoints.map((b) => snapshot.request.messages[b.message]!.content)).not.toContain(
        "USER"
      )
      expect(contents(snapshot).join("\n")).not.toContain("Note")
    })

    it("keeps skipped barriers out of the text when depth notes share a role", async () => {
      const snapshot = await assembled(
        chat({
          notes: [
            chatNote("a", "First.", { mode: "depth", depth: 0, role: "system" }),
            chatNote("b", "Skipped.", { mode: "depth", depth: 0, role: "system" }, never),
            chatNote("c", "Last.", { mode: "depth", depth: 0, role: "system" })
          ],
          events: on("a", "b", "c")
        })
      )
      expect(contents(snapshot).at(-1)).toBe("system: First.\nLast.")
    })

    it("puts a due depth-zero note after send_if_empty's filler, and a skipped one nowhere", async () => {
      for (const fields of [onMirasTurn, never]) {
        const snapshot = await assembled(
          chat({
            messages: [
              { side: "user", content: "USER" },
              { side: "assistant", content: "Reply." }
            ],
            preset: preset({ send_if_empty: "Continue." }),
            notes: [authorNote({ mode: "depth", depth: 0, role: "system" }, fields)],
            events: on("note-z-author")
          })
        )
        expect(contents(snapshot).slice(-2)).toEqual(
          fields === never ? ["assistant: Reply.", "user: Continue."] : ["user: Continue.", "system: Tobin is soaked."]
        )
      }
    })

    it("keeps section note roles beside relative and in-chat main prompts", async () => {
      for (const absolute of [false, true]) {
        for (const [section, role] of [
          ["after_main_prompt", "user"],
          ["before_main_prompt", "assistant"]
        ] as const) {
          const snapshot = await assembled(
            chat({
              preset: preset({
                prompts: [
                  {
                    identifier: "main",
                    role: "system",
                    content: "MAIN",
                    injection_position: absolute ? 1 : 0,
                    injection_depth: 1
                  }
                ]
              }),
              notes: [authorNote({ mode: "section", section, role })],
              events: on("note-z-author")
            })
          )
          expect(contents(snapshot)).toContain(`${role}: Tobin is soaked.`)
        }
      }
    })

    it("sends an older import's note with an interval every turn: notes no longer come and go (DESIGN §4.1)", async () => {
      for (const interval of [0, 1, 2, 3]) {
        const snapshot = await assembled(
          chat({
            notes: [authorNote({ mode: "depth", depth: 0, role: "system" }, { interval })],
            events: on("note-z-author")
          })
        )
        expect(contents(snapshot).join("\n")).toContain("soaked")
        expect(snapshot.pieces.find((p) => p.id === "note:note-z-author")?.source).toMatchObject({
          activation: { kind: "note", interval: null, userMessages: null, due: true }
        })
      }
    })
  })

  it("keeps the newest messages the preset's budget allows, and says so", async () => {
    const messages: Array<FixtureMessage> = Array.from({ length: 40 }, (_, i) => ({
      side: i % 2 === 0 ? "assistant" : "user",
      content: `message ${i} ${"word ".repeat(40)}`
    }))
    const snapshot = await assembled(
      chat({ messages, preset: preset({ openai_max_context: 1000, openai_max_tokens: 200 }) })
    )
    const sent = snapshot.request.messages.filter((m) => m.content.startsWith("message"))
    expect(sent.length).toBeGreaterThan(5)
    expect(sent.length).toBeLessThan(40)
    expect(sent.at(-1)!.content).toMatch(/^message 39 /)
    expect(snapshot.issues.map((i) => i.kind)).toContain("history_truncated")
    // The model's own context bounds it too.
    const small = await assembled(chat({ messages, model: model({ context: 600 }) }))
    expect(small.request.messages.filter((m) => m.content.startsWith("message")).length).toBeLessThan(sent.length)
    // So does a prefill the model is sent: it's context too.
    const prefilled = await assembled(
      chat({
        messages,
        preset: preset({ openai_max_context: 1000, openai_max_tokens: 200, assistant_prefill: "word ".repeat(80) }),
        model: model({ prefill: "assistant" })
      })
    )
    expect(prefilled.request.prefill).toBeTruthy()
    expect(prefilled.request.messages.filter((m) => m.content.startsWith("message")).length).toBeLessThan(sent.length)
  })

  it("fails when the preset's own prompts don't fit its budget", async () => {
    await expect(
      assembled(
        chat({
          preset: preset({
            openai_max_context: 50,
            prompts: [{ identifier: "main", role: "system", content: "x ".repeat(400) }]
          })
        })
      )
    ).rejects.toThrow(/don't fit/)
  })

  it("sends the prefill to a model that takes one, and reports it dropped otherwise (DESIGN §1.2)", async () => {
    const withPrefill = chat({ preset: preset({ assistant_prefill: "*{{char}} sighs.*  " }) })
    const sent = await assembled({ ...withPrefill, model: model({ prefill: "assistant" }) })
    expect(sent.request.prefill).toBe("*Mira sighs.*")
    expect(chatCompletionsFields(sent.request, "openai-chat").messages).toContainEqual({
      role: "assistant",
      content: "*Mira sighs.*"
    })
    const dropped = await assembled(withPrefill)
    expect(dropped.request.prefill).toBeNull()
    expect(dropped.issues).toEqual([expect.objectContaining({ kind: "prefill_dropped" })])
  })

  it("impersonates with the preset's impersonation prompt and prefill when the user's character speaks", async () => {
    const snapshot = await assembled(
      chat({
        target: { speaker: "tobin" },
        preset: preset({ assistant_impersonation: "{{user}}:" }),
        model: model({ prefill: "assistant" })
      })
    )
    expect(snapshot.inputs.type).toBe("impersonate")
    expect(contents(snapshot).at(-1)).toMatch(/^system: \[Write your next reply from the point of view of Tobin/)
    expect(snapshot.request.prefill).toBe("Tobin:")
  })

  it("runs the preset's prompt-only regex scripts once the user approved them (ARCHITECTURE §9)", async () => {
    const doc = preset({
      extensions: {
        regex_scripts: [
          regexScript("strip", { findRegex: "/<thinking>[\\s\\S]*?<\\/thinking>/g", maxDepth: 1 }),
          regexScript("wrap", { findRegex: "/(late)/", replaceString: "[{{match}}|$1|{{char}}]", trimStrings: ["t"] }),
          regexScript("backreference", { findRegex: "/(a)\\1/" })
        ]
      }
    })
    const fixture = chat({
      messages: [
        { side: "assistant", content: "<thinking>old</thinking>You're late." },
        { side: "user", content: "The road flooded." },
        { side: "assistant", content: "<thinking>new</thinking>Write it down." },
        { side: "user", content: "Done." }
      ],
      preset: doc
    })
    const off = await assembled(fixture)
    expect(contents(off)).toContain("assistant: <thinking>new</thinking>Write it down.")
    const on = await assembled({ ...fixture, preset: { ...doc, regex_approved: true } })
    // Within its depths only: the oldest reply keeps its thinking.
    expect(contents(on)).toContain("assistant: Write it down.")
    expect(contents(on)).toContain("assistant: <thinking>old</thinking>You're [lae|lae|Mira].")
    expect(on.issues).toEqual([expect.objectContaining({ kind: "regex_skipped" })])
    expect(on.issues[0]!.message).toContain("backreference")

    // Time is bounded per context: V8 stops a pattern that would take seconds, which would
    // have emptied the newest reply; it's sent as written.
    const scripted = (messages: ReadonlyArray<FixtureMessage>, scripts: ReadonlyArray<object>, context = 20_000) =>
      assembled({
        ...fixture,
        messages,
        preset: {
          ...preset({ openai_max_context: context, extensions: { regex_scripts: scripts } }),
          regex_approved: true
        }
      })
    const nested = `${"(".repeat(300)}a*${")*".repeat(300)}`
    const slow = await scripted(
      [...fixture.messages, { side: "assistant", content: "a".repeat(43_000) }],
      [regexScript("heavy", { findRegex: `/${nested}/g` })]
    )
    expect(slow.issues.map((i) => i.message)).toContain(
      "The regex scripts ran out of time (200 ms for one context): the rest of the messages are sent without them."
    )
    expect(contents(slow).at(-2)).toBe(`assistant: ${"a".repeat(43_000)}`)
    // Another turn could leave them the time they lacked: what it didn't cover isn't cached as stable.
    expect(slow.request.breakpoints.map((b) => b.reason)).not.toContain("history")

    // And so is the text they make, replaced or copied: the script stops, the context doesn't.
    const growing = await scripted(
      [{ side: "assistant", content: "q".repeat(3_000) }, ...fixture.messages],
      [regexScript("heavy", { findRegex: "/q/g", replaceString: "b".repeat(200_000) })]
    )
    const tooMuch = 'The regex script "copy 16" was skipped where it failed: it made more text than one context allows.'
    expect(growing.issues.map((i) => i.message)).toContain(
      'The regex script "heavy" was skipped where it failed: it made more text than one context allows.'
    )
    expect(contents(growing)).toContain(`assistant: ${"q".repeat(3_000)}`)
    // Seventeen scripts that each copy a 500,000-character reply make 8,500,000 characters.
    const copies = Array.from({ length: 17 }, (_, i) => regexScript(`copy ${i}`, { findRegex: "/^/g" }))
    const copied = await scripted(
      [
        { side: "assistant", content: "Old." },
        { side: "user", content: "Go on." },
        { side: "assistant", content: "q".repeat(500_000) },
        { side: "user", content: "Last." }
      ],
      copies,
      200_000
    )
    expect(copied.issues.map((i) => i.message)).toContain(tooMuch)
    // What ran out depends on the messages after: the ones it skipped aren't cached as stable.
    expect(copied.request.breakpoints.map((b) => b.reason)).not.toContain("history")
  })

  it("expands a card's prompt override before the preset, and fills its {{original}}", async () => {
    const snapshot = await assembled(
      chat({
        cards: [
          {
            entity: "mira",
            doc: { ...mira, system_prompt: "{{setvar::mood::grim}}{{original}} Be terse.{{original}}" }
          },
          { entity: "tobin", doc: tobin }
        ],
        preset: preset({
          prompts: [
            { identifier: "main", role: "system", content: "Narrate." },
            { identifier: "nsfw", role: "system", content: "Mood: {{getvar::mood}}." }
          ]
        })
      })
    )
    expect(contents(snapshot)[0]).toBe("system: Narrate. Be terse.")
    expect(contents(snapshot)).toContain("system: Mood: grim.")
  })

  it("doesn't stop reading the path at templates that expand to nothing", async () => {
    const messages: Array<FixtureMessage> = [
      ...Array.from({ length: 30 }, (_, i): FixtureMessage => ({
        side: i % 2 ? "user" : "assistant",
        content: `old ${i}`
      })),
      ...Array.from({ length: 200 }, (): FixtureMessage => ({
        side: "assistant",
        content: `{{// ${"x".repeat(200)}}}`,
        macroMode: "template"
      }))
    ]
    const snapshot = await assembled(
      chat({ messages, preset: preset({ openai_max_context: 4000, openai_max_tokens: 300 }) })
    )
    expect(contents(snapshot).filter((m) => m.includes("old ")).length).toBe(30)
  })

  it("reads the path as far as the text the regex scripts leave fills the budget", async () => {
    const messages = Array.from({ length: 400 }, (_, i): FixtureMessage => ({
      side: "assistant",
      content: `<thinking>${"x".repeat(400)}</thinking>reply ${i}`
    }))
    const doc = preset({
      extensions: { regex_scripts: [regexScript("strip", { findRegex: "/<thinking>[\\s\\S]*?<\\/thinking>/g" })] }
    })
    const snapshot = await assembled(chat({ messages, preset: { ...doc, regex_approved: true } }))
    expect(contents(snapshot).filter((m) => m.startsWith("assistant: reply ")).length).toBe(400)
    expect(snapshot.issues).toEqual([])
  })

  it("sends the one-turn direction through the preset's direction prompt, as typed (DESIGN §2.2)", async () => {
    const snapshot = await assembled(chat({ target: { direction: "Have {{char}} leave. {{random::a::b}}" } }))
    expect(contents(snapshot).at(-1)).toBe(
      "user: [The user has written a direction for Mira's next message. It is not part of the story; follow it closely: Have {{char}} leave. {{random::a::b}}]"
    )
    expect(snapshot.pieces.find((p) => p.id === "preset:direction")!.source).toEqual({
      kind: "preset",
      ref: "ref-preset",
      revision: "rev-preset",
      identifier: "direction",
      condition: "with_direction"
    })
    expect(snapshot.issues).toEqual([])
  })

  it("places cache breakpoints before what changes next turn (DESIGN §5.5)", async () => {
    const snapshot = await assembled(
      chat({
        messages: [
          { side: "assistant", content: "one" },
          { side: "user", content: "two" },
          { side: "assistant", content: "three" },
          { side: "user", content: "four" }
        ],
        notes: [note("A note.", 2, "system")]
      })
    )
    const messages = contents(snapshot)
    const byReason = Object.fromEntries(snapshot.request.breakpoints.map((b) => [b.reason, messages[b.message]]))
    // The note moves down as the chat grows: the next request starts to differ there.
    expect(byReason).toEqual({ history: "user: two", prefix: "system: [Start a new Chat]" })
    expect(snapshot.request.breakpoints[0]!.reason).toBe("history")

    // Merged into a message of the chat, a note makes that message change: the breakpoint
    // goes before it. With nothing that moves, it's the chat's last message.
    const merged = await assembled(
      chat({
        messages: [
          { side: "assistant", content: "one" },
          { side: "user", content: "two" },
          { side: "assistant", content: "three" },
          { side: "user", content: "four" }
        ],
        notes: [note("A note.", 1, "assistant")],
        preset: preset({ custom_prompt_post_processing: "merge" })
      })
    )
    const mergedMessages = contents(merged)
    expect(mergedMessages[merged.request.breakpoints[0]!.message]).toBe("user: two")
    expect(mergedMessages).toContain("assistant: three\n\nA note.")
    const still = await assembled(chat())
    expect(contents(still)[still.request.breakpoints[0]!.message]).toBe("user: The road flooded.")

    // A regex script within a depth changes a message once it's deeper: the breakpoint goes
    // before the first message whose text it will change.
    const depthBound = (fields: Record<string, unknown>) =>
      assembled(
        chat({
          messages: [
            { side: "assistant", content: "<thinking>a</thinking>one" },
            { side: "user", content: "two" },
            { side: "assistant", content: "<thinking>b</thinking>three" },
            { side: "user", content: "four" },
            { side: "assistant", content: "five" },
            { side: "user", content: "six" }
          ],
          preset: {
            ...preset({
              extensions: {
                regex_scripts: [regexScript("strip", { findRegex: "/<thinking>[\\s\\S]*?<\\/thinking>/g", ...fields })]
              }
            }),
            regex_approved: true
          }
        })
      )
    const stripped = await depthBound({ maxDepth: 3 })
    expect(contents(stripped)).toContain("assistant: three")
    expect(contents(stripped)[stripped.request.breakpoints[0]!.message]).toBe("user: two")
    const kept = await depthBound({ minDepth: 4 })
    expect(contents(kept)).toContain("assistant: <thinking>b</thinking>three")
    expect(contents(kept)[kept.request.breakpoints[0]!.message]).toBe("user: two")
    // Past its depths for good, or within them for good, a script changes nothing later.
    const settled = await depthBound({ maxDepth: 1 })
    expect(contents(settled)[settled.request.breakpoints[0]!.message]).toBe("user: six")
  })
})

describe("several characters (DESIGN §5.0–§5.4)", () => {
  const group = (fields: Partial<AssemblyFixture> = {}) =>
    chat({
      participants: ["mira", "oren"],
      messages: [
        { side: "assistant", content: "Ledger's open.", speaker: "mira" },
        { side: "assistant", content: "Ferry's shut.", speaker: "oren" },
        { side: "user", content: "Both of you, listen." }
      ],
      target: { speaker: "oren" },
      preset: preset({ group_nudge_prompt: "[Write the next reply only as {{char}}.]" }),
      ...fields
    })

  it("keeps the name of a speaker who left on its messages, as after a persona change (owner 2026-10-28)", async () => {
    const selene = card("Selene", { description: "{{char}} sails." })
    const snapshot = await assembled(
      group({
        cards: [...chat().cards, { entity: "selene", doc: selene }],
        messages: [
          { side: "user", content: "I was Selene then.", speaker: "selene" },
          { side: "assistant", content: "Ferry's shut.", speaker: "oren" },
          { side: "user", content: "Now I'm Tobin." }
        ],
        preset: preset({ group_nudge_prompt: "[Write the next reply only as {{char}}.]", names_behavior: 2 })
      })
    )
    // With names in the message content (ST's names_behavior 2), every message says who wrote it.
    const text = contents(snapshot).join("\n")
    expect(text).toContain("user: Selene: I was Selene then.")
    expect(text).toContain("user: Tobin: Now I'm Tobin.")
    // The definitions are the cast's: the departed persona's card isn't sent.
    expect(text).not.toContain("Selene sails.")
  })

  it("puts each card in a labelled block at the Definitions marker, with stable bindings and the speaker named at the tail", async () => {
    const snapshot = await assembled(
      group({
        preset: withDefinitions(
          preset({
            group_nudge_prompt: "[Write the next reply only as {{char}}.]",
            prompts: [{ identifier: "main", role: "system", content: "Write for {{char}}; {{user}} is the user." }]
          })
        )
      })
    )
    const messages = contents(snapshot)
    expect(snapshot.inputs.mode).toBe("layouts")
    expect(messages[0]).toBe("system: Write for Mira, Oren; Tobin is the user.")
    expect(messages).toContain(
      'system: <character name="Mira">\nMira keeps the ledger for Tobin.\n\nExact.\n\nA flood.\n</character>\n\n<character name="Oren">\nOren runs the ferry.\n</character>\n\n<persona name="Tobin">\nTobin draws maps.\n</persona>'
    )
    // Definitions wins: the per-field markers stay empty.
    expect(messages.filter((m) => m.includes("Mira keeps the ledger"))).toHaveLength(1)
    // ST's group names: everyone but the user's character is named in the text.
    expect(messages).toContain("assistant: Mira: Ledger's open.")
    expect(messages).toContain("user: Both of you, listen.")
    expect(messages.at(-1)).toBe("system: [Write the next reply only as Oren.]")
    // The card blocks keep pointing at the fields they hold.
    expect(snapshot.pieces.find((p) => p.id === "card:oren:description")!.messages).toEqual([
      messages.findIndex((m) => m.includes('<character name="Mira">'))
    ])
  })

  it("ignores a chat's old card layout choice, and says so once", async () => {
    for (const layout of ["concat", "swap_tail"] as const) {
      const snapshot = await assembled(group({ events: [at(null, { key: "layout.cards", value: layout })] }))
      expect(contents(snapshot)).toEqual(contents(await assembled(group())))
      expect(snapshot.issues.filter((i) => i.kind === "layout_ignored")).toHaveLength(1)
    }
  })

  it("projects roles by alternation and by perspective", async () => {
    const roles = async (projection: "alternate" | "perspective") =>
      (await assembled(group({ events: [at(null, { key: "roles.projection", value: projection })] }))).request.messages
        .filter((m) => /Ledger|Ferry|listen/.test(m.content))
        .map((m) => m.role)
    expect(await roles("alternate")).toEqual(["assistant", "user", "assistant"])
    expect(await roles("perspective")).toEqual(["user", "assistant", "user"])
  })

  it("lets the user's character speak, with the impersonation prompt naming them", async () => {
    const snapshot = await assembled(group({ target: { speaker: "tobin" } }))
    expect(contents(snapshot).at(-1)).toMatch(/^system: \[Write your next reply from the point of view of Tobin/)
  })

  it("uses pinned bindings over the cast's (DESIGN §5.3)", async () => {
    const snapshot = await assembled(
      group({
        events: [at(null, { key: "macro.binding", value: { name: "char", value: "the cast" } })],
        preset: preset({ prompts: [{ identifier: "main", role: "system", content: "Write for {{char}}." }] })
      })
    )
    expect(contents(snapshot)[0]).toBe("system: Write for the cast.")
  })

  it("fills the per-field markers field by field, each character's part wrapped, in cast order", async () => {
    const snapshot = await assembled(group())
    const messages = contents(snapshot)
    expect(messages).toContain(
      "system: <Mira>\nMira keeps the ledger for Tobin.\n</Mira>\n<Oren>\nOren runs the ferry.\n</Oren>"
    )
    // Oren has no personality or scenario: his parts are left out.
    expect(messages).toContain("system: <Mira>\nExact.\n</Mira>")
    expect(messages).toContain("system: <Mira>\nA flood.\n</Mira>")
    expect(snapshot.pieces.find((p) => p.text === "[Start a new group chat. Group members: {{group}}]")).toBeUndefined()
    expect(snapshot.pieces.some((p) => p.id === "preset:utility.new_group_chat_prompt")).toBe(true)
  })
})

describe("lorebook assembly", () => {
  const entries = [
    loreEntry({ keys: ["flooded"], content: "The levee is guarded.", position: "before_char", order: 200 }, 0),
    loreEntry(
      { keys: ["flooded"], secondary_keys: ["road"], content: "The toll is waived.", position: "after_char" },
      1
    ),
    loreEntry({ constant: true, content: "The river runs north.", position: "at_depth", depth: 0, role: "user" }, 2),
    loreEntry({ keys: ["unsaid"], content: "Absent." }, 3),
    loreEntry({ keys: ["/(?=road)/"], content: "Unsafe." }, 4)
  ]
  const attached = { id: "book", entity: "book-entity", revision: "book-rev", doc: loreBook(entries).document }
  const fixture = (fields: Partial<AssemblyFixture> = {}) =>
    chat({
      lorebooks: [attached],
      events: [at(null, { key: "lorebook.attach", value: { ref: "book" as never } })],
      ...fields
    })
  it.each(["empty", "tiny", "constant", "ineligible", "disabled"])(
    "keeps the latest user message with %s lore in a small context",
    async (kind) => {
      const doc = loreBook(
        kind === "empty"
          ? []
          : [
              loreEntry(
                kind === "tiny"
                  ? { keys: ["unsaid"], content: "A fact." }
                  : kind === "constant"
                    ? { constant: true, content: "A fact." }
                    : { constant: kind === "disabled", enabled: kind !== "disabled", content: "x".repeat(5000) }
              )
            ]
      ).document
      const f = fixture({
        lorebooks: [{ ...attached, doc }],
        cards: [{ entity: "mira", doc: card("Mira", { description: "A traveler." }) }],
        persona: "",
        messages: [{ side: "user", content: "hello" }],
        events: [...fixture().events!, at(null, { key: "layout.cards", value: "concat" })],
        preset: preset({ openai_max_context: 96, openai_max_tokens: 16 })
      })
      expect(contents(await assembled({ ...f, lorebooks: [] })).join("\n")).toContain("hello")
      expect(contents(await assembled(f)).join("\n")).toContain("hello")
    }
  )
  it("does not preview content of rejected candidates", async () => {
    const doc = loreBook([
      loreEntry({ keys: ["unsaid"], content: "{{space::5000000}}{{random::a::b}}" }),
      loreEntry({ keys: ["flooded"], secondary_keys: ["unsaid"], content: "{{space::5000000}}" }, 1),
      loreEntry({ constant: true, probability: 0, content: "{{space::5000000}}" }, 2)
    ]).document
    const result = await assembled(fixture({ lorebooks: [{ ...attached, doc }] }))
    expect(result.issues).toEqual([])
    expect(Object.keys(result.frozen).filter((key) => key.startsWith("lore:"))).toEqual([])
  })
  it("bounds cumulative preview work, including ignore_budget candidates", async () => {
    const doc = loreBook(
      Array.from({ length: 100 }, (_, uid) =>
        loreEntry({ constant: true, ignore_budget: true, content: "{{space::200000}}" }, uid)
      )
    ).document
    const result = await assembled(
      fixture({ lorebooks: [{ ...attached, doc }], preset: preset({ openai_max_context: 10000000 }) })
    )
    expect(result.issues.some((i) => i.message.includes("preview") && i.message.includes("limit"))).toBe(true)
    expect(
      result.pieces.filter((p) => p.source.kind === "lorebook").reduce((n, p) => n + p.text.length, 0)
    ).toBeLessThan(4000000)
  })
  it.each([2, 20])(
    "reserves identical history and examples space with %s messages regardless of tail activation",
    async (count) => {
      const doc = loreBook([
        loreEntry({ constant: true, probability: 50, content: "LORE " + "l".repeat(290) })
      ]).document
      const f = fixture({
        lorebooks: [{ ...attached, doc }],
        events: [...fixture().events!, at(null, { key: "layout.cards", value: "concat" })],
        cards: [
          { entity: "mira", doc: { ...mira, mes_example: "<START>\n{{user}}: EXAMPLE?\n{{char}}: " + "e".repeat(200) } }
        ],
        messages: Array.from({ length: count }, (_, i) => ({
          side: i % 2 ? "user" : "assistant",
          content: `MESSAGE_${i} ` + "x".repeat(140)
        })),
        preset: preset({ openai_max_context: 600, openai_max_tokens: 50 })
      })
      let on: ContextSnapshot | undefined
      let off: ContextSnapshot | undefined
      for (let now = 1; now <= 40 && !(on && off); now++) {
        const result = await assembled({ ...f, now })
        if (contents(result).some((text) => text.includes("LORE"))) on = result
        else off = result
      }
      expect(on).toBeDefined()
      expect(off).toBeDefined()
      const history = (s: ContextSnapshot) => s.request.messages.filter((m) => m.content.includes("MESSAGE_"))
      expect(history(on!)).toEqual(history(off!))
      expect(on!.request.messages.filter((m) => m.name?.startsWith("example_"))).toEqual(
        off!.request.messages.filter((m) => m.name?.startsWith("example_"))
      )
      expect(on!.request.breakpoints).toEqual(off!.request.breakpoints)
    }
  )
  it("cuts ignore_budget overflow from our tail allowance without dropping history", async () => {
    const doc = loreBook([
      loreEntry({ constant: true, ignore_budget: true, content: "OVERFLOW".repeat(1000) })
    ]).document
    const result = await assembled(
      fixture({
        lorebooks: [{ ...attached, doc }],
        events: [...fixture().events!, at(null, { key: "layout.cards", value: "concat" })],
        preset: preset({ openai_max_context: 600, openai_max_tokens: 50 })
      })
    )
    expect(contents(result).join("\n")).not.toContain("OVERFLOW")
    expect(contents(result).join("\n")).toContain("The road flooded.")
    expect(result.issues.some((i) => i.message.includes("allowance"))).toBe(true)
  })
  it("uses the attached primary book once and the embedded book only as fallback", async () => {
    const doc = loreBook([loreEntry({ constant: true, content: "PRIMARY_LORE" })], {}, "Primary world").document
    const f = fixture({
      lorebooks: [{ ...attached, doc, sourceName: "Primary world" }],
      cards: [{ entity: "mira", doc: { ...mira, character_book: doc, extensions: { world: "Primary world" } } }]
    })
    const result = await assembled(f)
    expect(
      contents(result)
        .join("\n")
        .match(/PRIMARY_LORE/g)
    ).toHaveLength(1)
    expect(result.pieces.filter((p) => p.source.kind === "lorebook").map((p) => p.source)).toEqual([
      expect.objectContaining({ book: "book", revision: "book-rev" })
    ])
    expect(
      contents(await assembled({ ...f, lorebooks: [] }))
        .join("\n")
        .match(/PRIMARY_LORE/g)
    ).toHaveLength(1)
  })
  it("leaves a card's own book out when the chat turns it off, as an ST import does when ST never imported it", async () => {
    const doc = loreBook([loreEntry({ constant: true, content: "CARD_LORE" })]).document
    const f = fixture({ cards: [{ entity: "mira", doc: { ...mira, character_book: doc } }] })
    expect(contents(await assembled(f)).join("\n")).toContain("CARD_LORE")
    const off = {
      ...f,
      events: [...f.events!, at(null, { key: "lorebook.embedded", value: { entity: "mira" as never, on: false } })]
    }
    expect(contents(await assembled(off)).join("\n")).not.toContain("CARD_LORE")
    const backOn = {
      ...off,
      events: [...off.events, at(null, { key: "lorebook.embedded", value: { entity: "mira" as never, on: true } })]
    }
    expect(contents(await assembled(backOn)).join("\n")).toContain("CARD_LORE")
  })
  it("counts message delays across the path independently of the scan window", async () => {
    const doc = loreBook([loreEntry({ constant: true, delay: 1100, content: "DELAY_LORE" })]).document
    const f = fixture({
      lorebooks: [{ ...attached, doc }],
      messages: Array.from({ length: 1200 }, () => ({ side: "user", content: "x".repeat(400) }))
    })
    expect(contents(await assembled(f)).join("\n")).toContain("DELAY_LORE")
    expect(contents(await assembled({ ...f, messages: f.messages.slice(0, 1000) })).join("\n")).not.toContain(
      "DELAY_LORE"
    )
  })
  it.each(["em_top", "em_bottom"] as const)("orders multiple %s examples as ST does", async (position) => {
    const doc = loreBook(
      [100, 200].map((order, uid) =>
        loreEntry(
          {
            constant: true,
            position,
            order,
            content: `<START>\n{{user}}: EXAMPLE_${order}?\n{{char}}: EXAMPLE_${order}.`
          },
          uid
        )
      )
    ).document
    const result = await assembled(
      fixture({ lorebooks: [{ ...attached, doc }], events: [...fixture().events!, loreByPosition] })
    )
    expect(result.request.messages.filter((m) => m.content.includes("EXAMPLE_")).map((m) => m.content)).toEqual(
      (position === "em_top" ? [200, 100] : [100, 200]).flatMap((order) => [`EXAMPLE_${order}?`, `EXAMPLE_${order}.`])
    )
  })
  it("omits wi_format for empty joined lore while retaining activation provenance", async () => {
    const doc = loreBook([loreEntry({ constant: true, content: "" })]).document
    const result = await assembled(
      fixture({ lorebooks: [{ ...attached, doc }], preset: preset({ wi_format: "[LORE {0}]" }) })
    )
    expect(contents(result).join("\n")).not.toContain("[LORE")
    expect(result.pieces.find((p) => p.source.kind === "lorebook")?.source).toMatchObject({
      activation: { status: "activated" }
    })
  })
  it("places ST markers and depth entries, records keys and skips, and surfaces refused regex", async () => {
    const result = await assembled(
      fixture({ preset: preset({ wi_format: "[{{char}}] {0}" }), events: [...fixture().events!, loreByPosition] })
    )
    expect(contents(result).join("\n")).toContain("[Mira] The levee is guarded.")
    expect(contents(result).join("\n")).toContain("The toll is waived.")
    expect(contents(result).at(-1)).toBe("user: The river runs north.")
    const tags = result.pieces.filter((p) => p.source.kind === "lorebook").map((p) => p.source)
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uid: 0,
          activation: { status: "activated", step: 0, why: { kind: "keys", primaryKey: "flooded", secondaryKeys: [] } }
        }),
        expect.objectContaining({
          uid: 3,
          activation: expect.objectContaining({ status: "skipped", reason: "no_primary" })
        })
      ])
    )
    expect(result.issues.some((i) => i.message.includes("Lookahead") && i.message.includes("AND ANY"))).toBe(true)
  })
  it("uses one stable tail block after every cache breakpoint in our layouts, including constants", async () => {
    const a = await assembled(fixture({ participants: ["mira", "oren"] }))
    const b = await assembled(
      fixture({ participants: ["mira", "oren"], messages: [{ side: "user", content: "The sky cleared." }] })
    )
    const block = a.request.messages.findIndex((m) => m.content.includes("The levee is guarded."))
    expect(a.request.messages[block]!.content).toBe(
      entries
        .slice(0, 3)
        .map((e) => e.content)
        .join("\n")
    )
    expect(a.request.breakpoints.every((p) => p.message < block)).toBe(true)
    expect(a.request.messages.slice(0, a.request.breakpoints.find((p) => p.reason === "prefix")!.message + 1)).toEqual(
      b.request.messages.slice(0, b.request.breakpoints.find((p) => p.reason === "prefix")!.message + 1)
    )
  })
  it("scans older messages independently of request budgeting, includes names and embedded persona books", async () => {
    const doc = loreBook([
      loreEntry({ keys: ["Tobin"], content: "Names activate." }),
      loreEntry({ keys: ["old-key"], scan_depth: 300, content: "Older lore.", position: "at_depth", depth: 0 }, 1)
    ]).document
    const messages: Array<FixtureMessage> = [
      { side: "user", content: "old-key" },
      ...Array.from({ length: 299 }, () => ({ side: "user" as const, content: "x".repeat(400) }))
    ]
    const result = await assembled(
      chat({
        messages,
        cards: [
          { entity: "mira", doc: mira },
          { entity: "tobin", doc: { ...tobin, character_book: doc } }
        ]
      })
    )
    expect(contents(result).join("\n")).toContain("Names activate.")
    expect(contents(result).join("\n")).toContain("Older lore.")
    expect(contents(result).join("\n")).not.toContain("old-key")
  })
  it("scans scripted templates and records recursive activation", async () => {
    const doc = loreBook([
      loreEntry({ keys: ["flooded"], content: "FIRST levee" }),
      loreEntry({ keys: ["levee"], content: "SECOND", position: "at_depth", depth: 0 }, 1)
    ]).document
    const script = regexScript("clear", { findRegex: "/flooded/g", replaceString: "clear", placement: [1] })
    const first = await assembled(fixture({ lorebooks: [{ ...attached, doc }] }))
    expect(
      first.pieces.some((p) => p.source.kind === "lorebook" && p.source.uid === 1 && p.source.activation.step === 1)
    ).toBe(true)
    const cleared = await assembled(
      fixture({
        lorebooks: [{ ...attached, doc }],
        messages: [{ side: "user", content: "flooded", macroMode: "template" }],
        preset: { ...preset({ extensions: { regex_scripts: [script] } }), regex_approved: true }
      })
    )
    expect(contents(cleared).join("\n")).not.toContain("FIRST")
  })
  it("keeps emergency outcomes and description draws identical on replay without persisting lore variable writes", async () => {
    const doc = loreBook([
      loreEntry({ constant: true, content: "{{setvar::x::leak}}A lantern." }),
      loreEntry({ keys: ["unsaid"], content: "{{setvar::x::hidden}}" }, 1)
    ]).document
    const f = fixture({
      lorebooks: [{ ...attached, doc }],
      cards: [
        { entity: "mira", doc: { ...mira, description: "{{random::a::b}}" } },
        { entity: "tobin", doc: tobin }
      ]
    })
    const outcome = matchLorebooks(
      [
        {
          id: attached.id,
          document: { ...doc, entries: doc.entries.map((e) => ({ ...e, content: e.uid === 0 ? "A lantern." : "" })) }
        }
      ],
      { messages: ["road"] },
      { budget: 1000 },
      () => 0.5,
      (text) => Math.ceil(text.length / 4)
    )
    const fallback = {
      ...outcome,
      replayable: false,
      previewEffects: {
        frozen: { "lore:book:0:content": { "synthetic-draw": "a" } },
        issues: [{ kind: "macro_limit" as const, message: "A captured preview issue." }]
      }
    }
    const first = await assembled(f, { loreFallback: fallback, random: () => 0.1 })
    expect(first.effects).toEqual([])
    expect(await assembled(f, { loreFallback: fallback, frozen: first.frozen, random: () => 0.9 })).toEqual(first)
  })
  it("replays probability and random content from pinned inputs and frozen values", async () => {
    const doc = loreBook(
      Array.from({ length: 30 }, (_, uid) =>
        loreEntry({ constant: true, probability: 50, content: `Lore ${uid} {{random::a::b::c}}` }, uid)
      )
    ).document
    const f = fixture({ lorebooks: [{ ...attached, doc }] })
    const first = await assembled(f, { random: () => 0.1 })
    expect(await assembled(f, { frozen: first.frozen, random: () => 0.9 })).toEqual(first)
  })
})

it.each([undefined, "", "Captain Aria"])(
  "uses nickname %s for macros, group nudges and transcript names",
  async (nickname) => {
    const expected = nickname || "Aria Vance"
    const snapshot = await assembled(
      chat({
        cards: [
          {
            entity: "mira",
            doc: card("Aria Vance", {
              ...(nickname === undefined ? {} : { nickname }),
              description: "{{char}} greets {{user}}."
            })
          },
          { entity: "oren", doc: oren },
          { entity: "tobin", doc: card("Tobin Display", { nickname: "Tobin" }) }
        ],
        participants: ["mira", "oren"],
        messages: [
          { side: "assistant", content: "{{char}} speaks.", macroMode: "template" },
          { side: "user", content: "Hello" }
        ],
        preset: preset({ names_behavior: 1, group_nudge_prompt: "Reply as {{char}}." })
      })
    )
    const text = contents(snapshot).join("\n")
    expect(text).toContain(`${expected} greets Tobin.`)
    expect(text).toContain(`${expected} speaks.`)
    expect(text).toContain(`Reply as ${expected}.`)
    expect(snapshot.request.messages.some((m) => m.name === expected.replaceAll(" ", "_"))).toBe(true)
    if (nickname) expect(text).not.toContain("Aria Vance")
  }
)

describe("conditioned prompts, {{speaker}} and {{direction}} (DESIGN §2.2)", () => {
  /**
   * ST's default preset (no group nudge, no impersonation prompt, no direction prompt) with a
   * prompt after the history for each condition, each naming who it was sent for.
   */
  const conditioned = (direction = true): PresetDoc => {
    const base = preset({ impersonation_prompt: "" })
    const template = base.prompts.find((p) => p.identifier === "main")!
    const own = (["always", "as_character", "as_user", "with_direction"] as const).map((condition) => ({
      ...template,
      identifier: `c-${condition}`,
      name: condition,
      system_prompt: false,
      content: `[${condition}: {{speaker}}${condition === "with_direction" && direction ? " / {{direction}}" : ""}]`,
      condition
    }))
    const prompts = [...base.prompts.filter((p) => p.identifier !== "direction"), ...own]
    const order = base.order.filter((e) => e.identifier !== "direction")
    const at = order.findIndex((e) => e.identifier === "newestMessage") + 1
    return {
      ...base,
      prompts,
      order: [
        ...order.slice(0, at),
        ...own.map((p) => ({ identifier: p.identifier, enabled: true })),
        ...order.slice(at)
      ]
    }
  }
  const sent = (snapshot: ContextSnapshot) =>
    snapshot.request.messages.flatMap((m) => m.content.split("\n")).filter((line) => /^\[(always|as_|with_)/.test(line))
  const group = { participants: ["mira", "oren"] }

  for (const [mode, cast] of [
    ["ST mode", {}],
    ["concat", group]
  ] as const)
    describe(mode, () => {
      it("sends each prompt only when its condition holds", async () => {
        const run = (target: NonNullable<AssemblyFixture["target"]>, summarizing = false) =>
          assembled(chat({ ...cast, preset: conditioned(), target }), { summarizing }).then(sent)
        expect(await run({ speaker: "mira" })).toEqual(["[always: Mira]", "[as_character: Mira]"])
        expect(await run({ speaker: "mira", direction: "Rain." })).toEqual([
          "[always: Mira]",
          "[as_character: Mira]",
          "[with_direction: Mira / Rain.]"
        ])
        expect(await run({ speaker: "tobin" })).toEqual(["[always: Tobin]", "[as_user: Tobin]"])
        expect(await run({ speaker: "tobin", direction: "Rain." })).toEqual([
          "[always: Tobin]",
          "[as_user: Tobin]",
          "[with_direction: Tobin / Rain.]"
        ])
        // A blank direction is none.
        expect(await run({ speaker: "mira", direction: "  " })).toEqual(["[always: Mira]", "[as_character: Mira]"])
        // A summary is written as no one, with no direction: only what's always sent.
        const summary = await run({ speaker: "mira", direction: "Rain." }, true)
        expect(summary).toEqual(["[always: {{speaker}}]"])
      })

      it("says which condition admitted a prompt, and keeps per-turn prompts out of the cached part", async () => {
        const snapshot = await assembled(chat({ ...cast, preset: conditioned(), target: { speaker: "mira" } }))
        expect(snapshot.pieces.find((p) => p.id === "preset:c-as_character")!.source).toMatchObject({
          kind: "preset",
          identifier: "c-as_character",
          condition: "as_character"
        })
        expect(snapshot.pieces.find((p) => p.id === "preset:c-always")!.source).not.toHaveProperty("condition")
        const messages = contents(snapshot)
        const history = snapshot.request.breakpoints.find((b) => b.reason === "history")!.message
        const first = messages.findIndex((m) => m.includes("[always: Mira]"))
        expect(first).toBeGreaterThan(history)
      })
    })

  it("adds the default direction prompt when the preset has none that reads the direction, and says so", async () => {
    const snapshot = await assembled(
      chat({ preset: conditioned(false), target: { speaker: "mira", direction: "Have {{char}} leave." } })
    )
    expect(contents(snapshot).at(-1)).toBe(
      "user: [The user has written a direction for Mira's next message. It is not part of the story; follow it closely: Have {{char}} leave.]"
    )
    expect(snapshot.pieces.find((p) => p.id === "direction:default")!.source).toEqual({
      kind: "assembler",
      what: "default direction prompt"
    })
    expect(snapshot.issues.map((i) => i.kind)).toEqual(["direction_prompt_missing"])
    // Without a direction, nothing is added and nothing is said.
    const plain = await assembled(chat({ preset: conditioned(false), target: { speaker: "mira" } }))
    expect(plain.issues).toEqual([])
    expect(contents(plain).join("\n")).not.toContain("has written a direction")
  })

  it("imports ST's group nudge and impersonation prompt as the prompts that say who writes", async () => {
    const doc = preset({
      group_nudge_prompt: "[Only {{char}} next.]",
      impersonation_prompt: "[Write as {{user}}.]"
    })
    const character = await assembled(chat({ ...group, preset: doc, target: { speaker: "oren" } }))
    expect(contents(character)).toContain("system: [Only Oren next.]")
    expect(contents(character).join("\n")).not.toContain("[Write as")
    const persona = await assembled(chat({ ...group, preset: doc, target: { speaker: "tobin" } }))
    expect(contents(persona)).toContain("system: [Write as Tobin.]")
    expect(contents(persona).join("\n")).not.toContain("[Only")
    // One character: sent all the same (ST sends its nudge in groups only).
    const one = await assembled(chat({ preset: doc, target: { speaker: "mira" } }))
    expect(contents(one).at(-1)).toBe("system: [Only Mira next.]")
  })

  it("keeps the messages before the history breakpoint byte-identical across speakers and directions", async () => {
    // Send as the persona, send as a member, generate as a member with a direction: each
    // request's cached part is the start of the next one's.
    const doc = preset({ group_nudge_prompt: "[Only {{char}} next.]", impersonation_prompt: "[Write as {{user}}.]" })
    const turns: Array<{ messages: Array<FixtureMessage>; target: NonNullable<AssemblyFixture["target"]> }> = [
      {
        messages: [
          { side: "assistant", content: "The tide is out.", speaker: "mira" },
          { side: "user", content: "Then we walk.", speaker: "tobin" }
        ],
        target: { speaker: "mira" }
      },
      {
        messages: [
          { side: "assistant", content: "The tide is out.", speaker: "mira" },
          { side: "user", content: "Then we walk.", speaker: "tobin" },
          { side: "assistant", content: "Mind the shoal.", speaker: "mira" },
          // Written by the user, as a member.
          { side: "user", content: "Ferry's closed anyway.", speaker: "oren" }
        ],
        target: { speaker: "mira" }
      },
      {
        messages: [
          { side: "assistant", content: "The tide is out.", speaker: "mira" },
          { side: "user", content: "Then we walk.", speaker: "tobin" },
          { side: "assistant", content: "Mind the shoal.", speaker: "mira" },
          { side: "user", content: "Ferry's closed anyway.", speaker: "oren" },
          { side: "assistant", content: "Since when?", speaker: "mira" }
        ],
        target: { speaker: "oren", direction: "Oren admits he sank it." }
      },
      {
        messages: [
          { side: "assistant", content: "The tide is out.", speaker: "mira" },
          { side: "user", content: "Then we walk.", speaker: "tobin" },
          { side: "assistant", content: "Mind the shoal.", speaker: "mira" },
          { side: "user", content: "Ferry's closed anyway.", speaker: "oren" },
          { side: "assistant", content: "Since when?", speaker: "mira" },
          { side: "assistant", content: "Since I sank it.", speaker: "oren" }
        ],
        target: { speaker: "tobin" }
      }
    ]
    const requests = await Promise.all(
      turns.map(({ messages, target }) => assembled(chat({ ...group, preset: doc, messages, target })))
    )
    for (let i = 0; i + 1 < requests.length; i++) {
      const before = requests[i]!.request
      const history = before.breakpoints.find((b) => b.reason === "history")!.message
      expect(requests[i + 1]!.request.messages.slice(0, history + 1)).toEqual(before.messages.slice(0, history + 1))
    }
  })

  it("adds a user turn right after a chat ending on the model's side, unless a user prompt follows or the model is prefilled", async () => {
    const ending = (fields: Partial<AssemblyFixture>) =>
      assembled(
        chat({
          ...group,
          messages: [
            { side: "assistant", content: "Ledger's open.", speaker: "mira" },
            { side: "user", content: "Both of you, listen.", speaker: "tobin" },
            { side: "assistant", content: "Ferry's shut.", speaker: "oren" }
          ],
          target: { speaker: "mira" },
          ...fields
        })
      )
    // By writer, a group chat ending on another character, with a system prompt after it: the
    // turn goes right after the last chat message, so the preset's tail stays last, and it's
    // no issue on the reply (owner 2026-10-28).
    const byWriter = await ending({ preset: preset({ group_nudge_prompt: "[Only {{char}} next.]" }) })
    expect(contents(byWriter).slice(-3)).toEqual([
      "assistant: Oren: Ferry's shut.",
      "user: [Write Mira's next message.]",
      "system: [Only Mira next.]"
    ])
    expect(byWriter.issues).toEqual([])
    expect(byWriter.pieces.find((p) => p.id === "assembler:last-turn")!.source).toEqual({
      kind: "assembler",
      what: "user turn so the request ends on one"
    })
    // Alternation by depth (even depths are the assistant's): three messages end on an
    // assistant one, four on a user one.
    const alternate = at(null, { key: "roles.projection", value: "alternate" })
    expect(contents(await ending({ events: [alternate] })).at(-1)).toBe("user: [Write Mira's next message.]")
    const four = await ending({
      events: [alternate],
      messages: [
        { side: "user", content: "Hello.", speaker: "tobin" },
        { side: "assistant", content: "Ledger's open.", speaker: "mira" },
        { side: "user", content: "Both of you, listen.", speaker: "tobin" },
        { side: "assistant", content: "Ferry's shut.", speaker: "oren" }
      ]
    })
    expect(contents(four).at(-1)).toBe("user: Oren: Ferry's shut.")
    expect(four.issues).toEqual([])
    // By perspective: the speaker's own last message is the assistant's.
    const perspective = await ending({
      events: [at(null, { key: "roles.projection", value: "perspective" })],
      target: { speaker: "oren" }
    })
    expect(contents(perspective).at(-1)).toBe("user: [Write Oren's next message.]")
    // A prefill continues the model's own turn: nothing is added.
    const prefilled = await ending({
      preset: preset({ assistant_prefill: "Mira:" }),
      model: model({ prefill: "assistant" })
    })
    expect(contents(prefilled).at(-1)).toBe("assistant: Oren: Ferry's shut.")
    expect(prefilled.request.prefill).toBe("Mira:")
    expect(prefilled.issues).toEqual([])
    // A user-role prompt after the history asks for the message itself: nothing is added.
    const asked = await ending({
      preset: preset({ group_nudge_prompt: "[Only {{char}} next.]" }),
      target: { speaker: "mira", direction: "Mira laughs." }
    })
    expect(contents(asked).slice(-3, -1)).toEqual(["assistant: Oren: Ferry's shut.", "system: [Only Mira next.]"])
    expect(contents(asked).at(-1)).toMatch(/^user: \[The user has written a direction for Mira's next message\./)
  })

  it("keeps a muted character's card and notes in the context, and never picks it to speak (DESIGN §3.5)", async () => {
    const orenNote: NoteInput = { ...note("Oren hates the rain.", 2, "system"), entity: "note-oren" }
    const muted = await assembled(
      chat({
        ...group,
        preset: preset({ group_nudge_prompt: "[Only {{char}} next.]" }),
        notes: [{ ...orenNote, doc: { ...orenNote.doc, owner: { card: "oren" as never } } }],
        events: [at(null, { key: "presence.set", value: { entity: "mira" as EntityId, present: false } })],
        target: {}
      })
    )
    const text = contents(muted).join("\n")
    expect(text).toContain("<Mira>\nMira keeps the ledger for Tobin.\n</Mira>")
    expect(text).toContain("Oren hates the rain.")
    // No speaker named: the first character not muted writes.
    expect(contents(muted)).toContain("system: [Only Oren next.]")
    const mutedNote = await assembled(
      chat({
        ...group,
        notes: [{ ...orenNote, doc: { ...orenNote.doc, owner: { card: "oren" as never } } }],
        events: [at(null, { key: "presence.set", value: { entity: "oren" as EntityId, present: false } })],
        target: { speaker: "mira" }
      })
    )
    expect(contents(mutedNote).join("\n")).toContain("Oren hates the rain.")
    expect(contents(mutedNote).join("\n")).toContain("<Oren>\nOren runs the ferry.\n</Oren>")
  })
})

describe("card definitions the way the preset says (DESIGN §5.0)", () => {
  const rook = card("Rook", { description: "{{char}} counts boats.", scenario: "A harbor." })
  const cards = [
    { entity: "mira", doc: mira },
    { entity: "oren", doc: oren },
    { entity: "rook", doc: rook },
    { entity: "tobin", doc: tobin }
  ]
  const cast = (participants: ReadonlyArray<string>, fields: Partial<AssemblyFixture> = {}) =>
    chat({ cards, participants, ...fields })
  const marker = (snapshot: ContextSnapshot, identifier: string) =>
    snapshot.request.messages.find((_, i) =>
      snapshot.pieces.some((p) => p.marker === identifier && p.messages.includes(i))
    )?.content

  it("joins each field over 1, 2 and 3 characters in cast order, skipping empty fields", async () => {
    const one = await assembled(cast(["mira"]))
    expect(marker(one, "charDescription")).toBe("<Mira>\nMira keeps the ledger for Tobin.\n</Mira>")
    const two = await assembled(cast(["mira", "oren"]))
    expect(marker(two, "charDescription")).toBe(
      "<Mira>\nMira keeps the ledger for Tobin.\n</Mira>\n<Oren>\nOren runs the ferry.\n</Oren>"
    )
    const three = await assembled(cast(["rook", "mira", "oren"]))
    expect(marker(three, "charDescription")).toBe(
      "<Rook>\nRook counts boats.\n</Rook>\n<Mira>\nMira keeps the ledger for Tobin.\n</Mira>\n<Oren>\nOren runs the ferry.\n</Oren>"
    )
    // Oren has no scenario and Rook no personality: their parts are left out.
    expect(marker(three, "scenario")).toBe("<Rook>\nA harbor.\n</Rook>\n<Mira>\nA flood.\n</Mira>")
    expect(marker(three, "charPersonality")).toBe("<Mira>\nExact.\n</Mira>")
  })

  it("takes the preset's join prefix and suffix, with {{char}} and <FIELDNAME> per part, or none", async () => {
    const custom = (prefix: string, suffix: string) =>
      cast(["mira", "oren"], {
        preset: {
          ...preset(),
          utility_prompts: { ...preset().utility_prompts, card_join_prefix: prefix, card_join_suffix: suffix }
        }
      })
    const labelled = await assembled(custom("[{{char}}'s <FIELDNAME>: ", "]"))
    expect(marker(labelled, "charDescription")).toBe(
      "[Mira's Description: Mira keeps the ledger for Tobin.]\n[Oren's Description: Oren runs the ferry.]"
    )
    expect(marker(labelled, "scenario")).toBe("[Mira's Scenario: A flood.]")
    const bare = await assembled(custom("", ""))
    expect(marker(bare, "charDescription")).toBe("Mira keeps the ledger for Tobin.\nOren runs the ferry.")
  })

  it("applies personality_format and scenario_format to the joined text, as do the macros in preset text", async () => {
    const snapshot = await assembled(
      cast(["mira", "rook"], {
        preset: preset({
          personality_format: "Personalities: {{personality}}",
          scenario_format: "[{{scenario}}]",
          prompts: [{ identifier: "main", role: "system", content: "All: {{description}}" }]
        })
      })
    )
    expect(marker(snapshot, "charPersonality")).toBe("Personalities: <Mira>\nExact.\n</Mira>")
    expect(marker(snapshot, "scenario")).toBe("[<Mira>\nA flood.\n</Mira>\n<Rook>\nA harbor.\n</Rook>]")
    expect(contents(snapshot)[0]).toBe(
      "system: All: <Mira>\nMira keeps the ledger for Tobin.\n</Mira>\n<Rook>\nRook counts boats.\n</Rook>"
    )
  })

  it("keeps a muted member's definition, and puts card notes at the top of their card's part", async () => {
    const tide: NoteInput = {
      ...note("Tide tables.", 1, "system"),
      entity: "note-oren",
      doc: {
        ...note("Tide tables.", 1, "system").doc,
        owner: { card: "oren" as never },
        placement: { mode: "section", section: "card" }
      }
    }
    const snapshot = await assembled(
      cast(["mira", "oren"], {
        notes: [tide],
        events: [at(null, { key: "presence.set", value: { entity: "oren" as EntityId, present: false } })]
      })
    )
    expect(marker(snapshot, "charDescription")).toBe(
      "<Mira>\nMira keeps the ledger for Tobin.\n</Mira>\n<Oren>\nTide tables.\nOren runs the ferry.\n</Oren>"
    )
  })

  it("doesn't change the definitions with the number of characters beyond the group rules", async () => {
    const silent = card("Silent")
    const nudge = preset({ group_nudge_prompt: "[Write the next reply only as {{char}}.]" })
    const alone = await assembled(cast(["mira"], { preset: nudge }))
    const joined = await assembled(
      chat({ cards: [...cards, { entity: "silent", doc: silent }], participants: ["mira", "silent"], preset: nudge })
    )
    for (const id of ["charDescription", "charPersonality", "scenario", "personaDescription"])
      expect(marker(joined, id)).toBe(marker(alone, id))
    // What changes is the group rules: names on messages and the group's new-chat prompt. The
    // group nudge is a prompt sent whenever the model writes as a character (DESIGN §2.2), one
    // character or many.
    expect(contents(alone)).toContain("assistant: You're late.")
    expect(contents(joined)).toContain("assistant: Mira: You're late.")
    expect(contents(joined).at(-1)).toBe("system: [Write the next reply only as Mira.]")
    expect(contents(alone).at(-1)).toBe("system: [Write the next reply only as Mira.]")
  })

  it("puts every card whole at the Definitions marker, which wins over the per-field markers", async () => {
    const snapshot = await assembled(cast(["mira", "oren"], { preset: withDefinitions(preset()) }))
    expect(marker(snapshot, "charDefinitions")).toBe(
      '<character name="Mira">\nMira keeps the ledger for Tobin.\n\nExact.\n\nA flood.\n</character>\n\n<character name="Oren">\nOren runs the ferry.\n</character>\n\n<persona name="Tobin">\nTobin draws maps.\n</persona>'
    )
    for (const id of ["charDescription", "charPersonality", "scenario", "personaDescription"])
      expect(marker(snapshot, id)).toBeUndefined()
    // Alone, without the per-field markers, it's the same.
    const doc = withDefinitions(preset())
    const alone = await assembled(
      cast(["mira", "oren"], {
        preset: {
          ...doc,
          order: doc.order.filter((e) => !["charDescription", "charPersonality", "scenario"].includes(e.identifier))
        }
      })
    )
    expect(marker(alone, "charDefinitions")).toBe(marker(snapshot, "charDefinitions"))
  })

  describe("card prompt overrides", () => {
    const strict = card("Strict", {
      description: "{{char}} rules.",
      system_prompt: "{{char}} first. {{original}} {{original}}",
      post_history_instructions: "Stay {{char}}."
    })
    const overriding = (fields: Partial<AssemblyFixture> = {}, doc = preset()) =>
      chat({
        cards: [...cards, { entity: "strict", doc: strict }],
        participants: ["mira", "strict"],
        target: { speaker: "strict" },
        preset: doc,
        ...fields
      })
    const allow = (doc: PresetDoc, allowed: boolean): PresetDoc => ({
      ...doc,
      prompts: doc.prompts.map((p) =>
        p.identifier === "main" || p.identifier === "jailbreak" ? { ...p, forbid_overrides: !allowed } : p
      )
    })
    const base = preset({
      prompts: [
        { identifier: "main", role: "system", content: "MAIN" },
        { identifier: "jailbreak", role: "system", content: "AFTER" }
      ]
    })

    it("takes the speaker's card prompts in place of main and jailbreak, the first {{original}} the replaced text", async () => {
      const snapshot = await assembled(overriding({}, allow(base, true)))
      expect(contents(snapshot)[0]).toBe("system: Strict first. MAIN ")
      expect(contents(snapshot)).toContain("system: Stay Strict.")
      expect(contents(snapshot)).not.toContain("system: AFTER")
      expect(snapshot.cardOverrides).toEqual([
        { identifier: "main", entity: "strict", revision: "rev-strict", status: "replaced" },
        { identifier: "jailbreak", entity: "strict", revision: "rev-strict", status: "replaced" }
      ])
      // Another speaker's card has none: the preset's prompts stay.
      const mira = await assembled(overriding({ target: { speaker: "mira" } }, allow(base, true)))
      expect(contents(mira)[0]).toBe("system: MAIN")
      expect(mira.cardOverrides).toBeUndefined()
    })

    it("keeps a prompt that forbids overrides or is off, and does nothing with an empty override", async () => {
      const forbidden = await assembled(overriding({}, allow(base, false)))
      expect(contents(forbidden)[0]).toBe("system: MAIN")
      expect(forbidden.cardOverrides?.map((o) => o.status)).toEqual(["forbidden", "forbidden"])
      const off = allow(base, true)
      const disabled = await assembled(
        overriding(
          {},
          { ...off, order: off.order.map((e) => (e.identifier === "main" ? { ...e, enabled: false } : e)) }
        )
      )
      expect(contents(disabled).join("\n")).not.toContain("Strict first.")
      expect(disabled.cardOverrides?.find((o) => o.identifier === "main")?.status).toBe("disabled")
      const empty = await assembled(
        overriding(
          {
            cards: [
              ...cards,
              { entity: "strict", doc: { ...strict, system_prompt: "", post_history_instructions: "" } }
            ]
          },
          allow(base, true)
        )
      )
      expect(contents(empty)[0]).toBe("system: MAIN")
      expect(empty.cardOverrides).toBeUndefined()
    })

    it("takes the speaking card's prompts on an impersonation turn too, and none for a persona without them (owner 2026-10-28)", async () => {
      const played = await assembled(
        overriding(
          { events: [at(null, { key: "played_by_me.set", value: { entities: ["strict"] } as never })] },
          allow(base, true)
        )
      )
      expect(played.inputs.type).toBe("impersonate")
      expect(contents(played)[0]).toBe("system: Strict first. MAIN ")
      expect(played.cardOverrides?.map((o) => o.status)).toEqual(["replaced", "replaced"])
      const persona = await assembled(overriding({ target: { speaker: "tobin" } }, allow(base, true)))
      expect(persona.inputs.type).toBe("impersonate")
      expect(contents(persona)[0]).toBe("system: MAIN")
      expect(persona.cardOverrides).toBeUndefined()
    })

    it("lets no card prompt replace a prompt of a preset made here, while an imported one keeps its file's value", async () => {
      const made = forbidCardOverrides(preset())
      expect(
        made.prompts
          .filter((p) => p.identifier === "main" || p.identifier === "jailbreak")
          .map((p) => p.forbid_overrides)
      ).toEqual([true, true])
      expect(preset().prompts.find((p) => p.identifier === "main")!.forbid_overrides).toBe(false)
      const file = importStPreset(
        JSON.stringify({ prompts: [{ identifier: "main", name: "Main Prompt", content: "M", forbid_overrides: true }] })
      )
      expect(file.document!.prompts.find((p) => p.identifier === "main")!.forbid_overrides).toBe(true)
      // The report names the prompts a card can replace.
      expect(file.report.issues.find((i) => i.code === "preset.overrides_allowed")?.message).toContain(
        "Post-History Instructions"
      )
      expect(file.report.issues.find((i) => i.code === "preset.overrides_allowed")?.message).not.toContain(
        "Main Prompt"
      )
    })
  })
})

describe("lorebooks: global books, placement and pins (DESIGN §1.3)", () => {
  const book = (id: string, entries: ReadonlyArray<ReturnType<typeof loreEntry>>, revision = `${id}-rev`) => ({
    id,
    entity: `${id}-entity`,
    revision,
    doc: loreBook(entries, {}, id).document
  })
  const attach = (ref: string) => at(null, { key: "lorebook.attach", value: { ref: ref as never } })

  it("reads global books unless the chat turns one off, and once when it's also attached", async () => {
    const world = book("world", [loreEntry({ constant: true, content: "GLOBAL_FACT" })])
    const f = chat({ lorebooks: [world], globalLorebooks: ["world"] })
    expect(contents(await assembled(f)).join("\n")).toContain("GLOBAL_FACT")
    const off = { ...f, events: [at(null, { key: "lorebook.global", value: { ref: "world" as never, on: false } })] }
    expect(contents(await assembled(off)).join("\n")).not.toContain("GLOBAL_FACT")
    const both = { ...f, events: [attach("world")] }
    expect(
      contents(await assembled(both))
        .join("\n")
        .match(/GLOBAL_FACT/g)
    ).toHaveLength(1)
    expect(contents(await assembled({ ...f, globalLorebooks: [] })).join("\n")).not.toContain("GLOBAL_FACT")
  })

  const positions = book("positions", [
    loreEntry({ constant: true, content: "AT_BEFORE", position: "before_char" }, 0),
    loreEntry({ constant: true, content: "AT_AFTER", position: "after_char" }, 1),
    loreEntry({ constant: true, content: "AT_DEPTH", position: "at_depth", depth: 1, role: "system" }, 2),
    loreEntry({ constant: true, content: "AT_AN_TOP", position: "an_top" }, 3),
    loreEntry({ constant: true, content: "<START>\n{{user}}: EM?\n{{char}}: EM.", position: "em_top" }, 4)
  ])

  it("puts every position in one block at the start of the tail when only below the history", async () => {
    const snapshot = await assembled(chat({ lorebooks: [positions], events: [attach("positions")] }))
    const block = contents(snapshot).find((m) => m.includes("AT_BEFORE"))!
    for (const text of ["AT_AFTER", "AT_DEPTH", "AT_AN_TOP", "EM?"]) expect(block).toContain(text)
    // After the history's last message, before the tail: here, at the end.
    expect(contents(snapshot).indexOf(block)).toBe(contents(snapshot).indexOf("user: The road flooded.") + 1)
    expect(snapshot.historyStart?.state?.pinnedLore).toBeUndefined()
    // Every breakpoint comes before it.
    expect(snapshot.request.breakpoints.every((b) => b.message < contents(snapshot).indexOf(block))).toBe(true)
  })

  it("places entries by position with the setting off", async () => {
    const snapshot = await assembled(
      chat({ lorebooks: [positions], events: [attach("positions"), loreByPosition], notes: [] })
    )
    const messages = contents(snapshot)
    expect(messages.findIndex((m) => m.includes("AT_BEFORE"))).toBeLessThan(
      messages.findIndex((m) => m.includes("keeps the ledger"))
    )
    expect(messages.find((m) => m.includes("AT_DEPTH"))).toBe("system: AT_DEPTH")
    expect(messages.indexOf("system: AT_DEPTH")).toBe(messages.indexOf("user: The road flooded.") - 1)
  })

  describe("pins above the history, with the setting off", () => {
    const pinning = book("pinning", [
      loreEntry({ keys: ["flooded"], content: "PIN_LEVEE", position: "before_char" }, 0),
      loreEntry({ keys: ["sunny"], content: "PIN_SUN", position: "before_char" }, 1),
      loreEntry({ keys: ["flooded"], content: "DEPTH_FLOOD", position: "at_depth", depth: 0, role: "system" }, 2)
    ])
    const first = chat({ lorebooks: [pinning], events: [attach("pinning"), loreByPosition] })
    const later: ReadonlyArray<FixtureMessage> = [
      ...first.messages,
      { side: "assistant", content: "Then wait." },
      { side: "user", content: "It's sunny now." }
    ]
    const next = (previous: ContextSnapshot, fields: Partial<AssemblyFixture> = {}) =>
      assembled({ ...first, messages: later, historyStart: previous.historyStart ?? null, ...fields })
    const text = (snapshot: ContextSnapshot) => contents(snapshot).join("\n")

    it("records entries above the history, never those after it", async () => {
      const snapshot = await assembled(first)
      expect(snapshot.historyStart?.state?.pinnedLore).toEqual([{ book: "pinning", revision: "pinning-rev", uid: 0 }])
      expect(text(snapshot)).toContain("DEPTH_FLOOD")
    })

    it("keeps them while the start holds, adds and pins a new match, and re-evaluates entries after the history", async () => {
      const one = await assembled(first)
      const two = await next(one)
      expect(text(two)).toContain("PIN_LEVEE")
      expect(text(two)).toContain("PIN_SUN")
      expect(text(two)).not.toContain("DEPTH_FLOOD")
      expect(two.historyMove).toBe("unchanged")
      expect(two.historyStart?.state?.pinnedLore?.map((p) => p.uid).toSorted()).toEqual([0, 1])
      expect(two.pieces.find((p) => p.id === "lore:pinning:0")?.source).toMatchObject({
        activation: { status: "activated", why: { kind: "pinned" } }
      })
      // Without the previous context, nothing is pinned: the levee no longer matches.
      expect(text(await assembled({ ...first, messages: later }))).not.toContain("PIN_LEVEE")
      // Pinned lore keeps the prefix stable until the start moves: (a) ends before it, the pinned marker after.
      const pinnedAt = two.request.breakpoints.find((b) => b.reason === "pinned")
      expect(pinnedAt).toBeDefined()
    })

    it("drops pins when the history's start moves, and re-evaluates", async () => {
      const one = await assembled(first)
      // The previous start was later, and a raised maximum lets it go back: the start moves.
      const moved = await next(one, {
        historyStart: {
          ...one.historyStart!,
          slotId: "slot-2",
          depth: 2,
          state: { ...one.historyStart!.state!, maximum: 1 }
        }
      })
      expect(moved.historyMove).toBe("restore")
      expect(text(moved)).not.toContain("PIN_LEVEE")
      expect(text(moved)).toContain("PIN_SUN")
      expect(moved.historyStart?.state?.pinnedLore).toEqual([{ book: "pinning", revision: "pinning-rev", uid: 1 }])
      expect(moved.pieces.find((p) => p.id === "lore:pinning:0")?.source).toMatchObject({
        activation: { status: "skipped", reason: "pin released: the history's start moved" }
      })
      // After a move, the prefix marker comes first, and it and everything before it are unchanged.
      expect(moved.request.breakpoints[0]?.reason).toBe("prefix")
      const prefixAt = moved.request.breakpoints[0]!.message
      expect(contents(moved).slice(0, prefixAt + 1)).toEqual(contents(one).slice(0, prefixAt + 1))
    })

    it("keeps the pinned prefix byte for byte when a pinned entry stops matching", async () => {
      const both: ReadonlyArray<FixtureMessage> = [
        ...first.messages.slice(0, -1),
        { side: "user", content: "The road flooded on a sunny day." }
      ]
      const one = await assembled({ ...first, messages: both })
      expect(text(one)).toContain("PIN_LEVEE")
      expect(text(one)).toContain("PIN_SUN")
      const two = await assembled({
        ...first,
        messages: [...both, { side: "assistant", content: "Then wait." }, { side: "user", content: "It's sunny now." }],
        historyStart: one.historyStart ?? null
      })
      expect(two.historyMove).toBe("unchanged")
      const pinnedAt = two.request.breakpoints.find((b) => b.reason === "pinned")!.message
      expect(contents(two).slice(0, pinnedAt + 1)).toEqual(contents(one).slice(0, pinnedAt + 1))
    })

    it("drops pins when a book is edited or the setting changes", async () => {
      const one = await assembled(first)
      const edited = await next(one, { lorebooks: [{ ...pinning, revision: "pinning-rev-2" }] })
      expect(text(edited)).not.toContain("PIN_LEVEE")
      const below = await next(one, { events: [attach("pinning")] })
      expect(below.historyStart?.state?.pinnedLore).toBeUndefined()
      expect(text(below)).not.toContain("PIN_LEVEE")
    })
  })
})

describe("cache breakpoints with pinned lore (DESIGN §1.3, §5.5)", () => {
  const kinds = (...list: ReadonlyArray<Stability>) => list.map((kind) => ({ kind }))
  const messages = kinds("prefix", "prefix", "pinned", "pinned", "summary", "history", "history", "volatile")
  it("puts (c) first while the start holds, then (a) before (b), then after the pinned lore", () => {
    expect(placeBreakpoints(messages).map((b) => [b.reason, b.message])).toEqual([
      ["history", 6],
      ["prefix", 1],
      ["summary", 4],
      ["pinned", 3]
    ])
  })
  it("puts (a) first after a move of the history's start", () => {
    expect(placeBreakpoints(messages, true).map((b) => b.reason)).toEqual(["prefix", "history", "summary", "pinned"])
  })
  it("reaches the history with (a) when nothing is pinned", () => {
    expect(placeBreakpoints(kinds("prefix", "prefix", "history", "volatile"), true)).toEqual([
      { message: 1, reason: "prefix" },
      { message: 2, reason: "history" }
    ])
  })
  it("marks the history, the prefix and the pinned lore for an explicit provider, within its markers", async () => {
    const pinning = {
      id: "pinning",
      entity: "pinning-entity",
      revision: "pinning-rev",
      doc: loreBook([loreEntry({ constant: true, content: "PINNED", position: "before_char" })]).document
    }
    const snapshot = await assembled(
      chat({
        lorebooks: [pinning],
        model: model({ cacheBreakpoints: "explicit" }),
        events: [at(null, { key: "lorebook.attach", value: { ref: "pinning" as never } }), loreByPosition],
        summaries: []
      })
    )
    expect(snapshot.request.breakpoints.map((b) => b.reason)).toEqual(["history", "prefix", "pinned"])
    expect(snapshot.issues.some((i) => i.kind === "cache_breakpoints")).toBe(false)
  })
  it("ends Anthropic's system prompt before the pinned lore, so pi-ai's marker there keeps the prefix", async () => {
    const pinning = {
      id: "pinning",
      entity: "pinning-entity",
      revision: "pinning-rev",
      doc: loreBook([loreEntry({ keys: ["flooded"], content: "PINNED", position: "before_char" })]).document
    }
    const claude = model({ kind: "anthropic", api: "anthropic-messages", cacheBreakpoints: "explicit" })
    const fixture = chat({
      preset: preset({ use_sysprompt: true }),
      lorebooks: [pinning],
      model: claude,
      events: [at(null, { key: "lorebook.attach", value: { ref: "pinning" as never } }), loreByPosition]
    })
    const snapshot = await assembled(fixture)
    const prefix = snapshot.request.breakpoints.find((b) => b.reason === "prefix")!
    const pinned = snapshot.request.breakpoints.find((b) => b.reason === "pinned")!
    const lore = snapshot.request.messages.findIndex((m) => m.content.includes("PINNED"))
    expect(lore).toBeGreaterThan(prefix.message)
    expect(lore).toBeLessThanOrEqual(pinned.message)
    const wire = providerRequest(snapshot.request, claude)
    const system = (wire.context as { systemPrompt?: string }).systemPrompt ?? ""
    // The system prompt is the prefix up to (a), and the pinned lore after it keeps its own marker.
    expect(system).not.toContain("PINNED")
    expect(system).toContain(snapshot.request.messages[prefix.message]!.content)
    expect(wire.breakpoints).toContain(pinned.message - prefix.message - 1)
    // Without pinned lore the system prompt takes the whole leading run, as before.
    const plain = await assembled({ ...fixture, lorebooks: [], events: [] })
    const plainWire = providerRequest(plain.request, claude)
    const leading = plain.request.messages.findIndex((m) => m.role !== "system")
    expect((plainWire.context as { messages: ReadonlyArray<unknown> }).messages.length).toBe(
      plain.request.messages.length - leading
    )
  })
})

describe("author's-note lore with the setting off (DESIGN §1.3)", () => {
  it("leaves the author's note beside the main prompt out of the prefix, so (a) holds when its lore goes", async () => {
    const book = {
      id: "an",
      entity: "an-entity",
      revision: "an-rev",
      doc: loreBook([loreEntry({ keys: ["flooded"], content: "AN_LORE", position: "an_top" }, 0)]).document
    }
    const author: NoteInput = {
      entity: "note-author",
      revision: "r",
      first: false,
      doc: {
        schema_version: 1,
        title: "author",
        content: "{{user}} is soaked.",
        placement: { mode: "section", section: "after_main_prompt" },
        owner: { chat: "chat-1" as never },
        exportable: false,
        kind: "author_note"
      } as NoteDoc
    }
    const first = chat({
      lorebooks: [book],
      notes: [author],
      events: [
        at(null, { key: "lorebook.attach", value: { ref: "an" as never } }),
        at(null, { key: "note.activate", value: { note: "note-author" as never } }),
        loreByPosition
      ]
    })
    const one = await assembled(first)
    expect(contents(one).join("\n")).toContain("AN_LORE")
    const two = await assembled({
      ...first,
      messages: [
        ...first.messages,
        { side: "assistant", content: "Then wait." },
        { side: "user", content: "It's sunny now." }
      ],
      historyStart: one.historyStart ?? null
    })
    expect(two.historyMove).toBe("unchanged")
    expect(contents(two).join("\n")).not.toContain("AN_LORE")
    const prefixAt = one.request.breakpoints.find((b) => b.reason === "prefix")!.message
    expect(contents(two).slice(0, prefixAt + 1)).toEqual(contents(one).slice(0, prefixAt + 1))
    expect(contents(one)[prefixAt]).not.toContain("is soaked")
  })
})
