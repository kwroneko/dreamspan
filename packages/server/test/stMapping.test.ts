// Empty author's notes still govern attached personas and lore; personas' notes (ARCHITECTURE §13).
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ReportBuilder } from "@rp/shared/importReport.ts"
import { parseStChatPart } from "../src/formats/stChat.ts"
import { parseStSettings } from "../src/formats/stData.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import {
  type CardInfo,
  chatStateChange,
  defaultPersona,
  type FolderContext,
  type Link
} from "../src/importer/stMapping.ts"
import { buildPersona } from "../src/importer/stParse.ts"

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const settings = (note: object) => parseStSettings(json({ extension_settings: { note } }), new ReportBuilder())
const header = (metadata: object) =>
  parseStChatPart(
    json({ chat_metadata: metadata }),
    {
      first: true,
      firstIndex: 0,
      carryAt: null
    },
    new ReportBuilder()
  ).header
const mapped = (metadata: object, defaults: object = {}, folder: Partial<FolderContext> = {}, link?: Link) =>
  chatStateChange(
    {
      settings: settings(defaults),
      cards: new Map(),
      personas: new Map(),
      personaNames: new Map(),
      worlds: new Map(),
      ...folder
    },
    {
      link: link ?? { card: null, group: null },
      header: header(metadata),
      spoke: new Set(),
      summaries: [],
      messages: 2,
      run: { length: 0, firstSlot: null, throughSlot: null }
    },
    null,
    true
  )

const cases = [
  { position: 1, depth: 0, role: 1, interval: 1, placement: { mode: "depth", depth: 0, role: "user" } },
  {
    position: 0,
    depth: 4,
    role: 1,
    interval: 1,
    placement: { mode: "section", section: "after_main_prompt", role: "user" }
  },
  {
    position: 2,
    depth: 4,
    role: 2,
    interval: 1,
    placement: { mode: "section", section: "before_main_prompt", role: "assistant" }
  },
  { position: 1, depth: 0, role: 0, interval: 0, placement: { mode: "depth", depth: 0, role: "system" } },
  { position: 1, depth: 4, role: 0, interval: 2, placement: { mode: "depth", depth: 4, role: "system" } }
]

describe("empty imported author's notes", () => {
  for (const [index, note] of cases.entries()) {
    for (const source of ["chat", "defaults", "settings only"] as const) {
      it(`keeps the placement, off, for ${source}, case ${index}`, () => {
        const metadata = {
          note_prompt: "",
          note_position: note.position,
          note_depth: note.depth,
          note_role: note.role,
          note_interval: note.interval
        }
        const defaults = {
          ...(source === "settings only" ? {} : { default: "" }),
          defaultPosition: note.position,
          defaultDepth: note.depth,
          defaultRole: note.role,
          defaultInterval: note.interval
        }
        const result = source === "chat" ? mapped(metadata, { default: "DEFAULT_TEXT" }) : mapped({}, defaults)
        expect(result.notes).toEqual([
          {
            kind: "author_note",
            title: "Author's Note",
            contents: [""],
            placement: note.placement,
            // Empty, ST sends nothing, so it comes in off; no frequency is kept (DESIGN §4.1).
            activate: false
          }
        ])
        expect(result.state.authorNote).not.toBeNull()
      })
    }
  }
  it("distinguishes missing settings from an explicitly empty note", () => {
    expect(mapped({}).notes).toEqual([])
    expect(mapped({}).state.authorNote).toBeNull()
    expect(mapped({ note_prompt: "" }).notes).toHaveLength(1)
  })
  it("uses default text and settings when the chat has no note", () => {
    expect(mapped({}, { default: "DEFAULT_TEXT", defaultRole: 1 }).notes).toMatchObject([
      { contents: ["DEFAULT_TEXT"], placement: { mode: "depth", depth: 4, role: "user" } }
    ])
  })
})

describe("ST's notes on import (DESIGN §4.1)", () => {
  const text = (interval: number) => ({ note_prompt: "Rain all day.", note_interval: interval })
  it("turns a chat's author's note on only if it has text and its frequency isn't 0, keeping no frequency", () => {
    for (const [interval, on] of [
      [1, true],
      [3, true],
      [0, false]
    ] as const) {
      const [note] = mapped(text(interval)).notes
      expect(note).toMatchObject({ kind: "author_note", contents: ["Rain all day."], activate: on })
      expect(note).not.toHaveProperty("interval")
    }
    expect(mapped({ note_prompt: "   ", note_interval: 1 }).notes[0]!.activate).toBe(false)
  })

  it("lets lorebook entries trigger on the author's note when ST's allowWIScan is set", () => {
    expect(mapped(text(1), { allowWIScan: true }).notes[0]).toMatchObject({ scanLore: true })
    expect(mapped(text(1)).notes[0]).not.toHaveProperty("scanLore")
  })

  it("reads the characters' own author's notes from the settings, by avatar file name", () => {
    const parsed = settings({
      allowWIScan: true,
      chara: [
        { name: "aria", prompt: "Aria hums.", useChara: true, position: 1 },
        { name: "bram", prompt: "Bram limps.", useChara: false, position: 2 },
        { name: 7, prompt: "dropped" }
      ]
    })
    expect(parsed?.characterNotes).toEqual([
      { card: "aria", prompt: "Aria hums.", useChara: true, position: 1 },
      { card: "bram", prompt: "Bram limps.", useChara: false, position: 2 }
    ])
    expect(parsed?.allowWIScan).toBe(true)
  })

  const card = (file: string, characterNote: string | null): CardInfo => ({
    entityId: `card-${file}` as EntityId,
    label: file,
    file,
    name: file,
    greetings: [],
    world: null,
    book: false,
    characterNote: characterNote as EntityId | null
  })
  const cards = new Map([
    ["aria", card("aria", "note-aria")],
    ["bram", card("bram", null)]
  ])

  it("switches a card's own author's note off in a group chat, as ST ignores it there, once", () => {
    const group = { id: "g", name: "Both", members: ["aria.png", "bram.png"], disabledMembers: [], chats: [], chatId: null }
    const first = mapped({}, {}, { cards }, { card: null, group })
    expect(first.events).toContainEqual({ key: "note.deactivate", value: { note: "note-aria" } })
    expect(first.state.characterNotesOff).toEqual(["note-aria"])
    const again = chatStateChange(
      { settings: settings({}), cards, personas: new Map(), personaNames: new Map(), worlds: new Map() },
      {
        link: { card: null, group },
        header: header({}),
        spoke: new Set(),
        summaries: [],
        messages: 2,
        run: { length: 0, firstSlot: null, throughSlot: null }
      },
      first.state,
      true
    )
    expect(again.events.filter((e) => e.key === "note.deactivate")).toEqual([])
    // A one-to-one chat leaves it as ST applies it.
    const single = mapped({}, {}, { cards }, { card: cards.get("aria")!, group: null })
    expect(single.events.filter((e) => e.key === "note.deactivate")).toEqual([])
  })

  it("switches what rides on a disabled author's note off in that chat, as ST sends none of it", () => {
    // ST 1.19.0 `setFloatingPrompt`: frequency 0 adds neither the persona nor the card's note;
    // an empty note that is due still carries both (`addPersonaDescriptionExtensionPrompt`).
    const folder = {
      settings: settings({}),
      cards,
      personas: new Map([["sam.png", "persona-sam" as EntityId]]),
      personaNotes: new Map([["persona-sam", "note-sam" as EntityId]]),
      personaNames: new Map(),
      worlds: new Map()
    }
    const chat = (metadata: object) =>
      chatStateChange(
        folder,
        {
          link: { card: cards.get("aria")!, group: null },
          header: header(metadata),
          spoke: new Set(["persona-sam" as EntityId]),
          summaries: [],
          messages: 2,
          run: { length: 0, firstSlot: null, throughSlot: null }
        },
        null,
        true
      )
    const off = chat(text(0))
    expect(off.events).toContainEqual({ key: "note.deactivate", value: { note: "note-sam" } })
    expect(off.events).toContainEqual({ key: "note.deactivate", value: { note: "note-aria" } })
    for (const metadata of [text(1), { note_prompt: "", note_interval: 1 }])
      expect(chat(metadata).events.filter((e) => e.key === "note.deactivate")).toEqual([])
  })

  it("says when ST replaced the chat's own author's note with the character's", () => {
    const replacing = { chara: [{ name: "aria", prompt: "Aria hums.", useChara: true, position: 0 }] }
    const link = { card: cards.get("aria")!, group: null }
    expect(mapped(text(1), replacing, { cards }, link).replacedAuthorNote).toBe(true)
    // An empty chat note had nothing to replace; a note before or after replaces nothing.
    expect(mapped({ note_prompt: "" }, replacing, { cards }, link).replacedAuthorNote).toBe(false)
    const before = { chara: [{ name: "aria", prompt: "Aria hums.", useChara: true, position: 1 }] }
    expect(mapped(text(1), before, { cards }, link).replacedAuthorNote).toBe(false)
  })
})

describe("ST personas (DESIGN §4.1, owner 2026-10-28)", () => {
  it("uses the chat lock then the imported default when no user message selected a persona", () => {
    const folder: FolderContext = {
      settings: parseStSettings(json({ power_user: { default_persona: "b.png" } }), new ReportBuilder()),
      cards: new Map(),
      personas: new Map([
        ["a.png", "a" as EntityId],
        ["b.png", "b" as EntityId]
      ]),
      personaNames: new Map(),
      worlds: new Map()
    }
    expect(folder.settings?.defaultPersona).toBe("b.png")
    expect(defaultPersona(folder, header({ persona: "a.png" }))).toBe("a")
    expect(defaultPersona(folder, header({ persona: "missing.png" }))).toBe("b")
    expect(defaultPersona(folder, null)).toBe("b")
    expect(defaultPersona({ ...folder, personas: new Map() }, null)).toBeNull()
    const change = mapped({}, {}, folder)
    expect(change.state.played).toEqual(["b"])
    expect(change.state.participants).toEqual(["b"])
  })

  const persona = (position: number) =>
    Effect.runSync(
      buildPersona(new Uint8Array(), "sam.png", {
        avatar: "sam.png",
        name: "Sam",
        description: "Sam is curious.",
        position,
        depth: 3,
        role: 1
      })
    ).library!
  const description = (library: ReturnType<typeof persona>) =>
    (JSON.parse(library.docJson) as { description: string }).description

  it("keeps a persona at the persona description in its card, with no note", () => {
    expect(description(persona(0))).toBe("Sam is curious.")
    expect(persona(0).noteDocJson).toBeNull()
  })

  it("puts one placed elsewhere in an ordinary note on its card, its only copy", () => {
    for (const [position, placement] of [
      // At the author's note's top or bottom: ST's default author's note place, with no settings.
      [2, { mode: "depth", depth: 4, role: "system" }],
      [3, { mode: "depth", depth: 4, role: "system" }],
      [4, { mode: "depth", depth: 3, role: "user" }],
      [9, { mode: "none" }]
    ] as const) {
      const library = persona(position)
      expect(description(library)).toBe("")
      expect(JSON.parse(library.noteDocJson!)).toEqual({
        schema_version: 1,
        title: "Persona description",
        content: "Sam is curious.",
        placement,
        exportable: true,
        on_by_default: true
      })
    }
  })
})
