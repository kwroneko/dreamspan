import { describe, expect, it } from "vitest"
import type { EntityId } from "../src/chat.ts"
import { type FoldableEvent, foldState, type StateEventData } from "../src/state.ts"

const e = (data: StateEventData, scope: string | null = null): FoldableEvent => ({ data, scope })
const mira = "mira" as EntityId
const tomas = "tomas" as EntityId

describe("foldState", () => {
  it("tracks participants in join order, and presence separately", () => {
    const state = foldState([
      e({ key: "participant.join", value: { entity: mira } }),
      e({ key: "participant.join", value: { entity: tomas } }),
      e({ key: "participant.join", value: { entity: mira } }),
      e({ key: "presence.set", value: { entity: tomas, present: false } })
    ])
    expect(state.participants).toEqual([mira, tomas])
    expect(state.absent).toEqual([tomas])
    expect(foldState([e({ key: "participant.leave", value: { entity: mira } })], state).participants).toEqual([tomas])
  })

  it("keeps scoped bindings apart, with later events replacing earlier ones", () => {
    const state = foldState([
      e({ key: "preset.binding", value: { ref: "chat-default" } }),
      e({ key: "preset.binding", value: { ref: "summary-preset" } }, "summarizer"),
      e({ key: "model.binding", value: { connection: "c1", model: "m1" } }),
      e({ key: "model.binding", value: { connection: "c1", model: "m2" } })
    ])
    expect(state.presetBindings).toEqual({
      "": { ref: "chat-default", revision: undefined },
      summarizer: { ref: "summary-preset", revision: undefined }
    })
    expect(state.modelBindings).toEqual({ "": { connection: "c1", model: "m2" } })
  })

  it("stashes a note without losing its binding", () => {
    const note = "outfit" as EntityId
    const state = foldState([
      e({ key: "note.binding", value: { note, revision: "r2" } }),
      e({ key: "note.activate", value: { note } }),
      e({ key: "note.deactivate", value: { note } })
    ])
    expect(state.activeNotes).toEqual([])
    expect(state.noteRevisions).toEqual({ [note]: "r2" })
  })
})
