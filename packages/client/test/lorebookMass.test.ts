import { describe, expect, it, vi } from "vitest"
import { emptyEntry } from "../src/features/editor/lorebookDefaults.ts"
import { applyMassChange, patchEdits, touched } from "../src/features/editor/lorebookMass.ts"
import {
  commonValue,
  lorebookEntrySettings,
  manyPatch,
  sectionSummary
} from "../src/features/editor/lorebookSettings.ts"
import { registerLorebookEntrySettings } from "../src/features/editor/lorebookSettingsDefaults.tsx"
import type { EditorStore } from "../src/features/editor/store.ts"
import { inScope, lorebookScopes, presetScopes } from "../src/features/editor/searchScopes.ts"

// The form's own controls aren't rendered here: only the settings' data and logic.
vi.mock("../src/features/editor/LorebookEntryDetails.tsx", () => ({
  CharacterFilter: () => null,
  DelayUntilRecursion: () => null,
  Keys: () => null
}))
vi.mock("../src/features/editor/controls.tsx", () => ({
  NumberField: () => null,
  TextField: () => null,
  TriggersField: () => null
}))

const entry = (uid: number, more: Partial<ReturnType<typeof emptyEntry>> = {}) => ({ ...emptyEntry(uid), ...more })

registerLorebookEntrySettings()
const setting = (id: string) => lorebookEntrySettings.list().find((s) => s.id === id)!

describe("changing a setting on many entries", () => {
  const entries = [entry(1), entry(2, { constant: true }), entry(3, { position: "at_depth", role: "user" })]

  it("changes only that setting, and only where it differs", () => {
    const edits = patchEdits([], entries, setting("strategy").patch("constant"))
    expect(edits).toEqual([
      { path: ["entries", "uid=1", "constant"], value: true },
      { path: ["entries", "uid=3", "constant"], value: true }
    ])
    expect(touched(edits)).toBe(2)
  })

  it("sets a position with its role, and leaves the role of a position without one", () => {
    expect(setting("position").patch("at_depth:assistant")).toEqual({ position: "at_depth", role: "assistant" })
    expect(setting("position").patch("before_char")).toEqual({ position: "before_char" })
    const edits = patchEdits(["character_book"], entries, setting("position").patch("before_char"))
    expect(edits.map((edit) => edit.path)).toEqual([
      ["character_book", "entries", "uid=1", "position"],
      ["character_book", "entries", "uid=2", "position"],
      ["character_book", "entries", "uid=3", "position"]
    ])
  })

  it("puts an unset value back as null (ST's default)", () => {
    expect(setting("case_sensitive").patch("inherit")).toEqual({ case_sensitive: null })
    expect(setting("scan_depth").patch(null)).toEqual({ scan_depth: null })
    expect(setting("probability").patch(40)).toEqual({ probability: 40, use_probability: true })
  })

  it("enables every entry without touching those already on", () => {
    const edits = patchEdits([], [entry(1), entry(2, { enabled: false })], { enabled: true })
    expect(edits).toEqual([{ path: ["entries", "uid=2", "enabled"], value: true }])
  })
})

describe("what search and replace looks in", () => {
  const fields = [
    { path: ["name"] },
    { path: ["entries", "uid=1", "comment"] },
    { path: ["entries", "uid=1", "content"] },
    { path: ["entries", "uid=1", "keys", 0] },
    { path: ["entries", "uid=1", "secondary_keys", 0] }
  ]
  const book = lorebookScopes([])
  it("a lorebook: content, keys, both or everything", () => {
    expect(inScope(fields, book, "content").map((f) => f.path.at(-1))).toEqual(["content"])
    expect(inScope(fields, book, "keys").map((f) => f.path.at(-2))).toEqual(["keys", "secondary_keys"])
    expect(inScope(fields, book, "both")).toHaveLength(3)
    expect(inScope(fields, book, "all")).toHaveLength(5)
  })
  it("a card's own book leaves the card's other fields out", () => {
    const card = [{ path: ["description"] }, { path: ["character_book", "entries", "uid=1", "content"] }]
    expect(inScope(card, lorebookScopes(["character_book"]), "all")).toEqual([card[1]])
  })
  it("a preset: prompt text, names, both or everything", () => {
    const preset = [
      { path: ["prompts", "identifier=main", "content"] },
      { path: ["prompts", "identifier=main", "name"] },
      { path: ["prefill", "assistant"] }
    ]
    expect(inScope(preset, presetScopes, "text")).toEqual([preset[0]])
    expect(inScope(preset, presetScopes, "names")).toEqual([preset[1]])
    expect(inScope(preset, presetScopes, "both")).toHaveLength(2)
    expect(inScope(preset, presetScopes, "all")).toHaveLength(3)
  })
})

describe("a change to many entries (owner, 2026-11-02)", () => {
  it("is an ordinary unsaved change: set as values, never saved or restored on its own", () => {
    const store = { setValue: vi.fn(), commit: vi.fn(), restoreRevision: vi.fn(), flush: vi.fn() }
    const edits = patchEdits([], [entry(1), entry(2)], { enabled: false })
    applyMassChange(store as unknown as EditorStore, "Disabled all 2 entries", edits)
    expect(store.setValue.mock.calls).toEqual([
      [["entries", "uid=1", "enabled"], false],
      [["entries", "uid=2", "enabled"], false]
    ])
    expect(store.commit).not.toHaveBeenCalled()
    expect(store.restoreRevision).not.toHaveBeenCalled()
  })

  it("changes nothing when every entry already has it", () => {
    const store = { setValue: vi.fn(), commit: vi.fn() }
    applyMassChange(store as unknown as EditorStore, "Enabled all 1 entry", [])
    expect(store.setValue).not.toHaveBeenCalled()
    expect(store.commit).not.toHaveBeenCalled()
  })
})

describe("the entry settings form for many entries (owner, 2026-11-02)", () => {
  const entries = [
    entry(1),
    entry(2, { enabled: false, sticky: 3 }),
    entry(3, { enabled: false, sticky: 3, group: "weather" })
  ]
  it("shows a shared value, or Mixed with how many have which", () => {
    expect(commonValue(setting("depth"), entries)).toEqual({ mixed: false, value: 4 })
    expect(commonValue(setting("enabled"), entries)).toEqual({ mixed: true, breakdown: "2 off, 1 on" })
  })
  it("applies several ticked settings at once; nothing chosen changes nothing", () => {
    const settings = lorebookEntrySettings.list()
    const patch = manyPatch(settings, { order: 50, strategy: "constant", position: undefined })
    expect(patch).toEqual({ order: 50, constant: true, vectorized: false })
    expect(touched(patchEdits([], entries, patch))).toBe(3)
  })
  it("clears a ticked empty field: unset where it can be, else a new entry's value", () => {
    const settings = lorebookEntrySettings.list()
    expect(manyPatch(settings, { sticky: "", group: "", depth: "" })).toEqual({ sticky: null, group: "", depth: 4 })
  })
  it("summarises a section by what differs from the defaults", () => {
    const timing = lorebookEntrySettings.list().filter((s) => s.section === "timing")
    expect(sectionSummary(timing, entry(1))).toBe("Default settings")
    expect(sectionSummary(timing, entries[1]!)).toBe("Sticky 3")
  })
})
