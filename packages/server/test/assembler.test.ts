// The context assembler's pipeline over in-memory chats (ARCHITECTURE §13). What ST would
// send for a preset is checked against ST itself by `npm run test:st`; these pin the rest:
// macros by source, rebuilding, notes, the budget, prefill, breakpoints and our layouts.
import type { EntityId } from "@rp/shared/chat.ts"
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
    expect(contents(slow).at(-1)).toBe(`assistant: ${"a".repeat(43_000)}`)
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

  it("ends with the one-turn direction, as typed (DESIGN §2.2)", async () => {
    const snapshot = await assembled(chat({ target: { direction: "Have {{char}} leave." } }))
    expect(contents(snapshot).at(-1)).toBe("system: Have {{char}} leave.")
    expect(snapshot.pieces.find((p) => p.id === "direction")!.source).toEqual({
      kind: "direction",
      version: "version-2"
    })
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
    expect(snapshot.pieces.find((p) => p.text === "[Start a new Chat]")!.id).toBe("preset:utility.new_chat_prompt")
  })
})
