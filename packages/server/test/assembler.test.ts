// The context assembler's pipeline over in-memory chats (ARCHITECTURE §13). What ST would
// send for a preset is checked against ST itself by `npm run test:st`; these pin the rest:
// macros by source, rebuilding, notes, the budget, prefill and our layouts.
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { PresetDoc } from "@rp/shared/docs/preset.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { PositionedEvent } from "../src/assembler/pipeline.ts"
import type { ContextSnapshot, ModelInput, NoteInput } from "../src/assembler/types.ts"
import { chatCompletionsFields } from "../src/assembler/wire.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
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

/** ST's default preset with these fields changed (ST's names, as a preset file has them). */
const preset = (fields: Record<string, unknown> = {}): PresetDoc =>
  importStPreset(JSON.stringify({ frequency_penalty: 0, ...fields })).document!

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
    exportable: true
  }
})

describe("the context assembler", () => {
  it("lays out ST's default preset for one character as ST does", async () => {
    const snapshot = await assembled(chat({ preset: presetFile("default") }))
    expect(contents(snapshot)).toEqual([
      "system: You narrate a story starring Mira and Tobin.",
      "system: Tobin draws maps.",
      "system: Mira keeps the ledger for Tobin.",
      "system: Exact.",
      "system: A flood.",
      "system: [A new story begins]",
      "assistant: You're late.",
      "user: The road flooded."
    ])
    expect(snapshot.inputs.mode).toBe("st")
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

  it("ends with the one-turn direction, as typed (DESIGN §2.2)", async () => {
    const snapshot = await assembled(chat({ target: { direction: "Have {{char}} leave." } }))
    expect(contents(snapshot).at(-1)).toBe("system: Have {{char}} leave.")
    expect(snapshot.pieces.find((p) => p.id === "direction")!.source).toEqual({
      kind: "direction",
      version: "version-2"
    })
  })
})

describe("our layouts (DESIGN §5.2–§5.4)", () => {
  const group = (fields: Partial<AssemblyFixture> = {}) =>
    chat({
      participants: ["mira", "oren"],
      messages: [
        { side: "assistant", content: "Ledger's open.", speaker: "mira" },
        { side: "assistant", content: "Ferry's shut.", speaker: "oren" },
        { side: "user", content: "Both of you, listen." }
      ],
      target: { speaker: "oren" },
      ...fields
    })

  it("puts each card in a labelled block, with stable bindings and the speaker named at the tail", async () => {
    const snapshot = await assembled(
      group({
        preset: preset({
          prompts: [{ identifier: "main", role: "system", content: "Write for {{char}}; {{user}} is the user." }]
        })
      })
    )
    const messages = contents(snapshot)
    expect(snapshot.inputs.mode).toBe("layouts")
    expect(messages[0]).toBe("system: Write for Mira, Oren; Tobin is the user.")
    expect(messages).toContain(
      'system: <character name="Mira">\nMira keeps the ledger for Tobin.\n\nExact.\n\nA flood.\n</character>\n\n<character name="Oren">\nOren runs the ferry.\n</character>'
    )
    expect(messages).toContain('system: <persona name="Tobin">\nTobin draws maps.\n</persona>')
    // ST's group names: everyone but the user's character is named in the text.
    expect(messages).toContain("assistant: Mira: Ledger's open.")
    expect(messages).toContain("user: Both of you, listen.")
    expect(messages.at(-1)).toBe("system: [Write the next reply only as Oren.]")
    // The card blocks keep pointing at the fields they hold.
    expect(snapshot.pieces.find((p) => p.id === "card:oren:description")!.messages).toEqual([
      messages.findIndex((m) => m.includes('<character name="Mira">'))
    ])
  })

  it("swaps the speaker's card to the tail in card-swap mode", async () => {
    const snapshot = await assembled(group({ events: [at(null, { key: "layout.cards", value: "swap_tail" })] }))
    const messages = contents(snapshot)
    expect(messages.join("\n")).not.toContain('<character name="Mira">')
    expect(messages.slice(-2)).toEqual([
      'system: <character name="Oren">\nOren runs the ferry.\n</character>',
      "system: [Write the next reply only as Oren.]"
    ])
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

  it("uses our layouts for one character when the chat picks one", async () => {
    const snapshot = await assembled(chat({ events: [at(null, { key: "layout.cards", value: "concat" })] }))
    expect(snapshot.inputs.mode).toBe("layouts")
    expect(contents(snapshot).join("\n")).toContain('<character name="Mira">')
  })
})
