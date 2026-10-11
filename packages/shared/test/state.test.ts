import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ChatId, EntityId } from "../src/chat.ts"
import { RefId, type RevisionId } from "../src/library.ts"
import type { ConnectionId, ModelId } from "../src/providers.ts"
import { type FoldableEvent, foldState, StateEventData, stateKeyIds, stateKeyProblems } from "../src/state.ts"

const e = (data: StateEventData, scope: string | null = null): FoldableEvent => ({ data, scope })
const mira = "mira" as EntityId
const tomas = "tomas" as EntityId
const ref = (id: string) => id as RefId
const connection = "c1" as ConnectionId
const model = (id: string) => id as ModelId

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
      e({ key: "preset.binding", value: { ref: ref("chat-default") } }),
      e({ key: "preset.binding", value: { ref: ref("summary-preset") } }, "summarizer"),
      e({ key: "model.binding", value: { connection, model: model("m1") } }),
      e({ key: "model.binding", value: { connection, model: model("m2") } })
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
      e({ key: "note.binding", value: { note, revision: "r2" as RevisionId } }),
      e({ key: "note.activate", value: { note } }),
      e({ key: "note.deactivate", value: { note } })
    ])
    expect(state.activeNotes).toEqual([])
    expect(state.noteRevisions).toEqual({ [note]: "r2" })
  })
})

describe("state key declarations", () => {
  it("name exactly the ids in each core key's value schema", () => {
    const keys = StateEventData.members.map((member) => member.fields.key.literal)
    expect(keys.sort()).toEqual(Object.keys(stateKeyIds).sort())
    for (const member of StateEventData.members) {
      expect(stateKeyProblems(member.fields.value.ast, stateKeyIds[member.fields.key.literal])).toEqual([])
    }
  })

  it("can't miss an id, wherever it sits", () => {
    const none = { ids: {} }
    const holes = [
      EntityId,
      Schema.Struct({ entity: EntityId }),
      Schema.Struct({ chat: ChatId }),
      Schema.Union([
        Schema.Struct({ mode: Schema.Literal("one"), name: Schema.String }),
        Schema.Struct({ mode: Schema.Literal("two"), ref: RefId })
      ]),
      Schema.Struct({ items: Schema.Array(Schema.Struct({ entity: EntityId })) }),
      Schema.Struct({ inner: Schema.Struct({ entity: EntityId }) }),
      Schema.Record(Schema.String, EntityId),
      Schema.Struct({ map: Schema.Record(EntityId, Schema.Boolean) }),
      Schema.Struct({ key: Schema.TemplateLiteral([EntityId, ":", RefId]) }),
      Schema.Struct({ entity: Schema.suspend(() => EntityId) })
    ]
    expect(holes.map((schema) => stateKeyProblems(schema.ast, none))).toEqual([
      [`entity id at "" isn't in a top-level field`],
      [`entity id in "entity" isn't declared`],
      [`chat id in "chat" isn't declared`],
      [`ref id in "ref" isn't declared`],
      [`entity id at "items[].entity" isn't in a top-level field`],
      [`entity id at "inner.entity" isn't in a top-level field`],
      [`entity id at ".*" isn't in a top-level field`],
      [`entity id at "map.<key>" isn't in a top-level field`],
      [`"key": an id inside a template literal can't be checked`],
      [`"entity": a suspended schema isn't searched`]
    ])
  })

  it("can't declare an id the schema doesn't hold, or the wrong table", () => {
    const declared = { ids: { entity: { table: "entity", kind: "card" } } } as const
    expect(stateKeyProblems(Schema.Struct({ entity: Schema.String }).ast, declared)).toEqual([
      `"entity" is declared as an id but its schema isn't an id schema`
    ])
    expect(stateKeyProblems(Schema.Struct({ entity: RefId }).ast, declared)).toEqual([
      `"entity" holds ref ids but is declared as entity`
    ])
  })
})
