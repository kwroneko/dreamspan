import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { EntityId } from "../src/chat.ts"
import { conditionCards, NOTE_SCHEMA_VERSION, NoteCondition, NoteDoc, readNoteCondition } from "../src/docs/note.ts"
import { droppedDrafts, validateDoc, valueField } from "../src/editing.ts"

const decode = Schema.decodeUnknownSync(NoteCondition)
const encode = Schema.encodeSync(NoteCondition)
const ids = (...names: Array<string>) => names as unknown as ReadonlyArray<EntityId>

const note = (condition: unknown) => ({
  schema_version: NOTE_SCHEMA_VERSION,
  title: "Outfit",
  content: "A red scarf.",
  placement: { mode: "tail", role: "system" },
  owner: { chat: "chat-1" },
  exportable: true,
  condition
})

describe("a note's condition", () => {
  it("reads the current shape, a list of cards", () => {
    expect(decode({ when: "turn", cards: ["ethan", "mira"] })).toEqual({ when: "turn", cards: ids("ethan", "mira") })
    expect(decode({ when: "not_muted", cards: ["ethan"] })).toEqual({ when: "not_muted", cards: ids("ethan") })
    expect(decode({ when: "always" })).toEqual({ when: "always" })
  })

  it("reads the single-card shape stored before as a list of that card", () => {
    expect(decode({ when: "turn", card: "ethan" })).toEqual({ when: "turn", cards: ids("ethan") })
    expect(decode({ when: "not_muted", card: "bram" })).toEqual({ when: "not_muted", cards: ids("bram") })
  })

  it("writes the list whichever shape it was read from", () => {
    expect(encode(decode({ when: "turn", card: "ethan" }))).toEqual({ when: "turn", cards: ["ethan"] })
    expect(encode(decode({ when: "not_muted", cards: ["a", "b"] }))).toEqual({ when: "not_muted", cards: ["a", "b"] })
  })

  it("needs at least one card, each once", () => {
    expect(() => decode({ when: "turn", cards: [] })).toThrow()
    expect(() => decode({ when: "turn", cards: ["ethan", "ethan"] })).toThrow()
    expect(() => decode({ when: "turn" })).toThrow()
    expect(() => decode({ when: "turn", cards: Array.from({ length: 101 }, (_, i) => `card-${i}`) })).toThrow()
    expect(() => decode({ when: "sometimes", cards: ["ethan"] })).toThrow()
  })

  it("is saved as the list: a note stored with one card is validated into the new shape", () => {
    const old = validateDoc("note", note({ when: "turn", card: "ethan" }))
    expect(old.ok && old.doc["condition"]).toEqual({ when: "turn", cards: ["ethan"] })
    const now = validateDoc("note", note({ when: "not_muted", cards: ["ethan", "mira"] }))
    expect(now.ok && now.doc["condition"]).toEqual({ when: "not_muted", cards: ["ethan", "mira"] })
    expect(validateDoc("note", note({ when: "turn", cards: [] })).ok).toBe(false)
    // The whole document round-trips to the new shape too.
    const doc = Schema.decodeUnknownSync(NoteDoc)(note({ when: "turn", card: "ethan" }))
    expect(Schema.encodeSync(NoteDoc)(doc).condition).toEqual({ when: "turn", cards: ["ethan"] })
  })

  it("keeps a draft saved in the single-card shape: it isn't text the schema drops", () => {
    const field = valueField(["condition"])
    const applied = note({ when: "turn", card: "ethan" })
    const valid = validateDoc("note", applied)
    if (!valid.ok) throw new Error("invalid")
    expect(droppedDrafts("note", applied, valid.doc, [{ field, content: '{"when":"turn","card":"ethan"}' }])).toEqual(
      []
    )
    // Whatever else a draft holds there still counts as dropped.
    const extra = { ...applied, condition: { when: "turn", cards: ["ethan"], note: "My text" } }
    const kept = validateDoc("note", extra)
    if (!kept.ok) throw new Error("invalid")
    expect(droppedDrafts("note", extra, kept.doc, [{ field, content: "" }])).toHaveLength(1)
  })

  it("is read from an undecoded document, either shape, absent or broken read as always", () => {
    expect(readNoteCondition({ when: "turn", card: "ethan" })).toEqual({ when: "turn", cards: ["ethan"] })
    expect(readNoteCondition({ when: "turn", cards: ["ethan", "mira"] })).toEqual({
      when: "turn",
      cards: ["ethan", "mira"]
    })
    expect(readNoteCondition(undefined)).toEqual({ when: "always" })
    expect(readNoteCondition({ when: "turn", cards: [] })).toEqual({ when: "always" })
    expect(conditionCards(readNoteCondition({ when: "not_muted", card: "bram" }))).toEqual(["bram"])
    expect(conditionCards({ when: "always" })).toEqual([])
  })
})
