import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ChatId, EntityId } from "../src/chat.ts"
import { RefId, type RevisionId } from "../src/library.ts"
import type { ConnectionId, ModelId } from "../src/providers.ts"
import { FoldableEvent, foldState, scopeIds, StateEventData, stateKeyIds, stateKeyProblems } from "../src/state.ts"

const e = (data: StateEventData, scope: FoldableEvent["scope"] = null): FoldableEvent => ({ data, scope })
const mira = "mira" as EntityId
const tomas = "tomas" as EntityId
const ref = (id: string) => id as RefId
const connection = "c1" as ConnectionId
const model = (id: string) => id as ModelId

describe("foldState", () => {
  it("unpins a macro without removing other bindings, including an explicitly empty pin", () => {
    const pinned = foldState([
      e({ key: "macro.binding", value: { name: "user", value: "Captain" } }),
      e({ key: "macro.binding", value: { name: "char", value: "" } })
    ])
    expect(pinned.macroBindings).toEqual({ user: "Captain", char: "" })
    const reset = foldState([e({ key: "macro.unbind", value: { name: "user" } })], pinned)
    expect(reset.macroBindings).toEqual({ char: "" })
    expect(pinned.macroBindings.user).toBe("Captain")
  })

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

  it("swaps a card in place, carrying presence, player and lore settings but keeping bindings dormant", () => {
    const progressed = "progressed" as EntityId
    const revision = "progression" as RevisionId
    const before = foldState([
      e({ key: "participant.join", value: { entity: tomas } }),
      e({ key: "participant.join", value: { entity: mira } }),
      e({ key: "presence.set", value: { entity: mira, present: false } }),
      e({ key: "played_by_me.set", value: { entities: [mira] } }),
      e({ key: "lorebook.binding", value: { entity: mira, ref: ref("lore") } }),
      e({ key: "lorebook.embedded", value: { entity: mira, on: false } }),
      e({ key: "card.binding", value: { entity: mira, revision } })
    ])
    const swapped = foldState([e({ key: "card.swap", value: { entity: progressed, replaces: mira } })], before)
    expect(swapped.participants).toEqual([tomas, progressed])
    expect(swapped.absent).toEqual([progressed])
    expect(swapped.playedByMe).toEqual([progressed])
    expect(swapped.lorebookBindings).toEqual({ [progressed]: "lore" })
    expect(swapped.embeddedLorebooks).toEqual({ [progressed]: false })
    expect(swapped.cardBindings[mira]?.revision).toBe(revision)
    expect(swapped.cardBindings[progressed]).toBeUndefined()
    const restored = foldState([e({ key: "card.swap", value: { entity: mira, replaces: progressed } })], swapped)
    expect(restored).toEqual(before)
    expect(foldState([e({ key: "card.swap", value: { entity: mira, replaces: progressed } })], before)).toBe(before)
    expect(foldState([e({ key: "card.swap", value: { entity: mira, replaces: mira } })], before)).toBe(before)
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

  it("takes a scope's binding off, so it follows the default again, and leaves other scopes alone", () => {
    const bound = foldState([
      e({ key: "preset.binding", value: { ref: ref("chat-default") } }),
      e({ key: "preset.binding", value: { ref: ref("summary-preset") } }, "summarizer"),
      e({ key: "model.binding", value: { connection, model: model("m1") } }),
      e({ key: "model.binding", value: { connection, model: model("m2") } }, "summarizer")
    ])
    const cleared = foldState([e({ key: "preset.unbind", value: {} }), e({ key: "model.unbind", value: {} })], bound)
    expect(cleared.presetBindings).toEqual({ summarizer: { ref: "summary-preset", revision: undefined } })
    expect(cleared.modelBindings).toEqual({ summarizer: { connection: "c1", model: "m2" } })
    // Bound again later on the path, it's the chat's own again.
    const again = foldState([e({ key: "model.binding", value: { connection, model: model("m3") } })], cleared)
    expect(again.modelBindings[""]).toEqual({ connection: "c1", model: "m3" })
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
    // An event's scope is checked the same way.
    expect(stateKeyProblems(Schema.Struct({ scope: FoldableEvent.fields.scope }).ast, scopeIds)).toEqual([])
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
