// Empty author's notes still govern attached personas and lore (ARCHITECTURE §13).
import { describe, expect, it } from "vitest"
import { ReportBuilder } from "@rp/shared/importReport.ts"
import { parseStChatPart } from "../src/formats/stChat.ts"
import { parseStSettings } from "../src/formats/stData.ts"
import { chatStateChange } from "../src/importer/stMapping.ts"

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
const mapped = (metadata: object, defaults: object = {}) =>
  chatStateChange(
    {
      settings: settings(defaults),
      cards: new Map(),
      personas: new Map(),
      personaNames: new Map(),
      worlds: new Map()
    },
    {
      link: { card: null, group: null },
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
      it(`preserves placement and frequency for ${source}, case ${index}`, () => {
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
            interval: note.interval,
            activate: note.interval > 0
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
