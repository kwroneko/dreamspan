import { describe, expect, it } from "vitest"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { StateMarkEvent, StateMarks } from "@dreamspan/shared/contextsApi.ts"
import {
  marksOf,
  registerStateMarkerKinds,
  stateMarkerKinds,
  stateMarksOf,
  type StateMarkerKind
} from "../src/features/chat/stateMarkers.ts"
import type { ChatSession } from "../src/features/chat/session.ts"

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

it("does not reread the whole branch when scrolling loads positional cast metadata", async () => {
  let positions = () => {}
  let changed = () => {}
  let revision = 0
  let pathRevision = 0
  let reads = 0
  const session = {
    id: "chat",
    get positionRevision() {
      return revision
    },
    snapshot: () => ({ forkId: "fork", leafSlotId: "s1", loading: false, pathRevision }),
    subscribe: (listener: () => void) => {
      changed = listener
      return () => {}
    },
    subscribePositions: (listener: () => void) => {
      positions = listener
      return () => {}
    },
    call: async () => {
      reads++
      return { ok: true, value: data(start) }
    }
  } as unknown as ChatSession
  const undo = registerStateMarkerKinds()
  const store = stateMarksOf(session)
  const stop = store.subscribe(() => {})
  await Promise.resolve()
  for (let i = 0; i < 20; i++) {
    positions()
    changed()
  }
  await Promise.resolve()
  expect(reads).toBe(1)
  revision++
  positions()
  await Promise.resolve()
  expect(reads).toBe(2)
  pathRevision++
  changed()
  await Promise.resolve()
  expect(reads).toBe(3)
  stop()
  for (const end of undo) end()
})

it("hides the previous branch's markers while the next branch is loading", async () => {
  let forkId = "one"
  const session = {
    id: "chat",
    positionRevision: 0,
    snapshot: () => ({ forkId, leafSlotId: "s1", loading: false, pathRevision: 0 }),
    subscribe: () => () => {},
    subscribePositions: () => () => {},
    call: async () => ({
      ok: true,
      value: data([...start, event("s1", "presence.set", { entity: "tobin", present: false })])
    })
  } as unknown as ChatSession
  const undo = registerStateMarkerKinds()
  const store = stateMarksOf(session)
  const stop = store.subscribe(() => {})
  await Promise.resolve()
  expect(store.at("s1" as SlotId)).toHaveLength(1)
  forkId = "two"
  expect(store.at("s1" as SlotId)).toHaveLength(0)
  stop()
  for (const end of undo) end()
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
  it("marks branch decision switches and reply presence mode, including equal-size off-list changes", () => {
    const marks = marksOf(
      data([
        ...start,
        event("s1", "decision.points", { off: ["presence"] }),
        event("s1", "agent.send_presence", { mode: "required" }),
        event("s2", "decision.points", { off: ["lore"] }),
        event("s3", "decision.points", { off: [] }),
        event("s3", "agent.send_presence", { mode: "off" }),
        event("s4", "decision.points", { off: ["next", "lore"] }),
        event("s5", "decision.points", { off: ["lore", "next"] }),
        event("s6", "decision.points", { off: [] }),
        event("s6", "decision.points", { off: ["next", "lore"] })
      ]),
      kinds()
    )
    expect(texts(marks, "s1")).toEqual(["Who is present in replies: off → required", "Decisions changed for this chat"])
    expect(texts(marks, "s2")).toEqual(["Decisions changed for this chat"])
    expect(texts(marks, "s3")).toEqual(["Who is present in replies: required → off", "Decisions changed for this chat"])
    expect(marks.get("s1")![0]!.open?.panel).toBe("chat")
    expect(marks.get("s1")![0]!.changes[1]!.explanation).toContain("Nothing is sent")
    expect(marks.get("s3")![0]!.changes[1]!.explanation).toContain("follows your decision connections again")
    expect(marks.has("s5")).toBe(false)
    expect(marks.has("s6")).toBe(false)
  })

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
      "Model set for this chat: Local · model-a · new and regenerated replies",
      "Context: one shared → separate per character"
    ])
    expect(texts(marks, "s3")).toEqual([
      "Model: Local · model-a → Local · model-b · new and regenerated replies",
      "Prompt preset set for this chat: Terse",
      "Lorebook on: Harbour"
    ])
    expect(texts(marks, "s4")).toEqual([
      "Wren was removed",
      "Tobin unmuted",
      "Model: your usual model again (was Local · model-b) · new and regenerated replies",
      "Card swap: off → on"
    ])
    expect(marks.get("s2")!.map((mark) => mark.open?.panel)).toEqual(["cast", "notes", "model", "chat"])
  })

  it("explains that model choices apply to new and regenerated replies, including scoped and cleared choices", () => {
    const marks = marksOf(
      data([
        event("s1", "model.binding", { connection: "c1", model: "m1" }),
        event("s2", "model.binding", { connection: "c1", model: "m2" }, "mira"),
        event("s3", "model.unbind", {}, "mira")
      ]),
      kinds()
    )
    expect(marks.get("s1")![0]!.changes[0]!.explanation).toBe(
      "From now on, new and regenerated replies in this chat use Local · model-a."
    )
    expect(marks.get("s2")![0]!.changes[0]!.explanation).toBe(
      "From now on, new and regenerated replies for Mira use Local · model-b."
    )
    expect(marks.get("s3")![0]!.changes[0]!.explanation).toBe(
      "From now on, new and regenerated replies for Mira use your usual model."
    )
    for (const slot of ["s1", "s2", "s3"]) expect(texts(marks, slot)[0]).toContain("new and regenerated replies")
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

  it("marks different bindings even when their names match", () => {
    const input = data([
      event(null, "model.binding", { connection: "c1", model: "m1" }),
      event(null, "preset.binding", { ref: "p1" }),
      event("s1", "model.binding", { connection: "c2", model: "m1" }),
      event("s1", "preset.binding", { ref: "p2" })
    ])
    const marks = marksOf({ ...input, names: { ...names, c2: "Local", p2: "Terse" } }, kinds())
    expect(texts(marks, "s1")).toEqual([
      "Model changed: Local · model-a · new and regenerated replies",
      "Prompt preset changed: Terse"
    ])
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

  it("marks clearing the played character", () => {
    const marks = marksOf(data([...start, event("s1", "played_by_me.set", { entities: [] })]), kinds())
    expect(texts(marks, "s1")).toEqual(["You no longer play Ash"])
  })

  it("shows a newly joined character's mute without claiming they can reply", () => {
    const marks = marksOf(
      data([
        ...start,
        event("s1", "participant.join", { entity: "wren" }),
        event("s1", "presence.set", { entity: "wren", present: false })
      ]),
      kinds()
    )
    expect(texts(marks, "s1")).toEqual(["Wren joined", "Wren muted"])
    expect(marks.get("s1")![0]!.changes[0]!.explanation).not.toContain("can reply")
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
