import { describe, expect, it } from "vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import type { StateMarkEvent, StateMarks } from "@rp/shared/contextsApi.ts"
import {
  marksOf,
  registerStateMarkerKinds,
  stateMarkerKinds,
  type StateMarkerKind
} from "../src/features/chat/stateMarkers.ts"

let seq = 0
const event = (slot: string | null, key: string, value: unknown, scope: string | null = null): StateMarkEvent => ({
  eventId: `e${seq++}`,
  slotId: slot as SlotId | null,
  versionId: null,
  origin: "user",
  scope,
  key,
  value
})
const names = {
  mira: "Mira",
  tobin: "Tobin",
  wren: "Wren",
  you: "Ash",
  other: "Bryn",
  mood: "Mood",
  lore: "Harbour lore",
  move1: "Mira's secret",
  move2: "Mira's secret (rest)",
  c1: "Local",
  m1: "model-a",
  m2: "model-b",
  p1: "Terse",
  book: "Harbour"
}
const data = (events: ReadonlyArray<StateMarkEvent>, notes: StateMarks["notes"] = {}): StateMarks => ({
  events,
  names,
  notes
})
const start = [
  event(null, "participant.join", { entity: "mira" }),
  event(null, "participant.join", { entity: "tobin" }),
  event(null, "participant.join", { entity: "you" }),
  event(null, "played_by_me.set", { entities: ["you"] })
]
const kinds = () => {
  const undo = registerStateMarkerKinds()
  const entries = stateMarkerKinds.list()
  for (const stop of undo) stop()
  return entries
}
const texts = (marks: ReturnType<typeof marksOf>, slot: string) =>
  (marks.get(slot) ?? []).flatMap((mark) => mark.changes.map((change) => change.text))

describe("the timeline's change markers", () => {
  it("marks nothing for where the chat started", () => {
    expect(marksOf(data(start), kinds()).size).toBe(0)
  })

  it("says what changed under the message it was recorded at, each kind in order", () => {
    const marks = marksOf(
      data(
        [
          ...start,
          event("s1", "presence.set", { entity: "tobin", present: false }),
          event("s2", "participant.join", { entity: "wren" }),
          event("s2", "note.activate", { note: "mood" }),
          event("s2", "model.binding", { connection: "c1", model: "m1" }),
          event("s2", "context.per_speaker", "separate"),
          event("s3", "model.binding", { connection: "c1", model: "m2" }),
          event("s3", "preset.binding", { ref: "p1" }),
          event("s3", "lorebook.attach", { ref: "book" }),
          event("s4", "model.unbind", {}),
          event("s4", "participant.leave", { entity: "wren" }),
          event("s4", "presence.set", { entity: "tobin", present: true }),
          event("s4", "cards.rotation", { on: true })
        ],
        { mood: { card: null, onByDefault: false, group: null } }
      ),
      kinds()
    )
    expect(texts(marks, "s1")).toEqual(["Tobin muted"])
    expect(texts(marks, "s2")).toEqual([
      "Wren joined",
      "Note on: Mood",
      "Model set for this chat: Local · model-a",
      "Context: one shared → separate per character"
    ])
    expect(texts(marks, "s3")).toEqual([
      "Model: Local · model-a → Local · model-b",
      "Prompt preset set for this chat: Terse",
      "Lorebook on: Harbour"
    ])
    expect(texts(marks, "s4")).toEqual([
      "Wren was removed",
      "Tobin unmuted",
      "Model: your usual model again (was Local · model-b)",
      "Card swap: off → on"
    ])
    expect(marks.get("s2")!.map((mark) => mark.open?.panel)).toEqual(["cast", "notes", "model", "chat"])
  })

  it("shows the net change of a message: a change taken back there is no marker", () => {
    const marks = marksOf(
      data([
        ...start,
        event("s1", "presence.set", { entity: "tobin", present: false }),
        event("s1", "presence.set", { entity: "tobin", present: true }),
        event("s1", "participant.join", { entity: "wren" }),
        event("s1", "participant.leave", { entity: "wren" }),
        event("s2", "cards.rotation", { on: true }),
        event("s2", "cards.rotation", { on: false }),
        // Said again, as it already was.
        event("s3", "presence.set", { entity: "tobin", present: true })
      ]),
      kinds()
    )
    expect(marks.size).toBe(0)
  })

  it("a persona switch is one change, not a join and a removal", () => {
    const marks = marksOf(
      data([
        ...start,
        event("s1", "participant.join", { entity: "other" }),
        event("s1", "played_by_me.set", { entities: ["other"] }),
        event("s1", "participant.leave", { entity: "you" })
      ]),
      kinds()
    )
    expect(texts(marks, "s1")).toEqual(["You play Bryn (was Ash)"])
  })

  it("notes follow their defaults and their moved groups", () => {
    const notes = {
      lore: { card: "mira", onByDefault: true, group: null },
      move1: { card: "mira", onByDefault: false, group: "g" },
      move2: { card: "mira", onByDefault: false, group: "g" }
    }
    const marks = marksOf(
      data(
        [
          ...start,
          // On by default: switching it on says nothing; off does.
          event("s1", "note.activate", { note: "lore" }),
          event("s2", "note.deactivate", { note: "lore" }),
          // One switch of a moved pair turns both.
          event("s3", "note.activate", { note: "move1" }),
          event("s4", "note.deactivate", { note: "move2" })
        ],
        notes
      ),
      kinds()
    )
    expect(texts(marks, "s1")).toEqual([])
    expect(texts(marks, "s2")).toEqual(["Note off: Harbour lore"])
    expect(texts(marks, "s3")).toEqual(["Notes on: Mira's secret, Mira's secret (rest)"])
    expect(texts(marks, "s4")).toEqual(["Notes off: Mira's secret, Mira's secret (rest)"])
  })

  it("leaves out a change that names something deleted for good", () => {
    const marks = marksOf(
      data([
        ...start,
        event("s1", "participant.join", { entity: "gone" }),
        event("s1", "note.activate", { note: "gone" })
      ]),
      kinds()
    )
    expect(marks.size).toBe(0)
  })

  it("takes a plugin's kind over its own keys, and does without a disabled one", () => {
    const counter: StateMarkerKind<number> = {
      id: "dice/rolls",
      source: "dice",
      order: 5,
      label: "Dice",
      description: "Where the dice were rolled.",
      keys: ["dice/roll"],
      initial: 0,
      step: (state) => state + 1,
      changes: (before, after) => [{ id: "rolls", text: `${after - before} rolls`, explanation: "Rolled here." }]
    }
    const undo = [
      ...registerStateMarkerKinds(),
      stateMarkerKinds.register(counter),
      stateMarkerKinds.disable("state.mute")
    ]
    const marks = marksOf(
      data([
        ...start,
        event("s1", "dice/roll", 4),
        event("s1", "dice/roll", 2),
        event("s1", "presence.set", { entity: "tobin", present: false })
      ]),
      stateMarkerKinds.list()
    )
    for (const stop of undo) stop()
    expect(texts(marks, "s1")).toEqual(["2 rolls"])
  })
})
