// The workshop's own card and persona (spec/WORKSHOP-CONTEXT.md §4.3), apart from the story
// defaults both ways, and converting a story preset to a workshop one (§4.4). Synthetic cards only.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId } from "@dreamspan/shared/chat.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import type { PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import { Effect } from "effect"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>
const stateOf = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const current = yield* api.GetChat({ chatId: chat.id })
    return foldState(
      yield* (yield* Reader).StateEventsAt({ userId: me.id, chatId: chat.id, slotId: current.activeLeafSlotId })
    )
  })

describe("workshop card and persona", () => {
  it.live("rolls back first-workshop seeds on failure and never recreates a deleted persona", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const missing = "00000000-0000-7000-8000-000000000000" as EntityId
      assert.strictEqual(yield* outcome(api.CreateWorkshop({ card: missing })), "NotFound")
      assert.isEmpty(yield* api.ListLibrary({ kind: "card" }))
      assert.isEmpty(yield* api.ListLibrary({ kind: "preset" }))
      assert.isNull((yield* api.GetWorkshopDefaults({})).persona)
      // The start card says the first workshop makes one; afterwards it doesn't.
      assert.isTrue((yield* api.GetWorkshopDefaults({})).makesPersona)
      const first = yield* api.CreateWorkshop({})
      const persona = (yield* api.GetWorkshopDefaults({})).persona!
      assert.isUndefined((yield* api.GetWorkshopDefaults({})).makesPersona)
      assert.deepStrictEqual((yield* stateOf(api, first)).playedByMe, [persona])
      yield* (yield* Writer).DeleteEntity({ userId: me.id, entityId: persona as EntityId })
      for (let n = 0; n < 2; n++) {
        const next = yield* api.CreateWorkshop({})
        assert.isEmpty((yield* stateOf(api, next)).playedByMe)
        assert.isNull((yield* api.GetWorkshopDefaults({})).persona)
        assert.isUndefined((yield* api.GetWorkshopDefaults({})).makesPersona)
        assert.lengthOf(yield* api.ListLibrary({ kind: "card" }), 1)
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("keeps the workshop persona and the story default persona independent both ways", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const tobin = yield* api.CreateCard({ label: "Tobin", name: "Tobin", persona: true })
      const ana = yield* api.CreateCard({ label: "Ana", name: "Ana", persona: true })
      yield* api.ChangeGenerationDefaults({ change: { persona: tobin.entityId } })
      // The first workshop makes the workshop persona; the story default stays.
      const first = yield* api.CreateWorkshop({})
      const made = (yield* api.GetWorkshopDefaults({})).persona!
      assert.notInclude([tobin.entityId, ana.entityId], made)
      assert.deepStrictEqual((yield* stateOf(api, first)).playedByMe, [made])
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, tobin.entityId)
      // Choosing the workshop persona leaves the story default alone…
      yield* api.SetWorkshopPersona({ persona: ana.entityId })
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, tobin.entityId)
      const second = yield* api.CreateWorkshop({})
      assert.deepStrictEqual((yield* stateOf(api, second)).playedByMe, [ana.entityId])
      // …and changing the story default leaves the workshop persona alone.
      yield* api.ChangeGenerationDefaults({ change: { persona: null } })
      assert.strictEqual((yield* api.GetWorkshopDefaults({})).persona, ana.entityId)
      const third = yield* api.CreateWorkshop({})
      assert.deepStrictEqual((yield* stateOf(api, third)).playedByMe, [ana.entityId])
      // A persona changed inside one workshop changes only that workshop.
      yield* api.ChangeCast({
        chatId: third.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [tobin.entityId] }
      })
      assert.deepStrictEqual((yield* stateOf(api, third)).playedByMe, [tobin.entityId])
      assert.deepStrictEqual((yield* stateOf(api, second)).playedByMe, [ana.entityId])
      assert.strictEqual((yield* api.GetWorkshopDefaults({})).persona, ana.entityId)
      // Cleared: new workshops start without a persona, and none is made again.
      yield* api.SetWorkshopPersona({ persona: null })
      const fourth = yield* api.CreateWorkshop({})
      assert.isEmpty((yield* stateOf(api, fourth)).playedByMe)
      assert.isNull((yield* api.GetWorkshopDefaults({})).persona)
      // One chosen at the start wins over the default, for that workshop.
      const chosen = yield* api.CreateWorkshop({ persona: tobin.entityId })
      assert.deepStrictEqual((yield* stateOf(api, chosen)).playedByMe, [tobin.entityId])
      // A card that isn't a persona can't be one.
      const plain = yield* api.CreateCard({ label: "Plain", name: "Plain" })
      assert.strictEqual(yield* outcome(api.SetWorkshopPersona({ persona: plain.entityId })), "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("gives a side chat the workshop persona, never the story persona or a story card", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const tobin = yield* api.CreateCard({ label: "Tobin", name: "Tobin", persona: true })
      const ana = yield* api.CreateCard({ label: "Ana", name: "Ana", persona: true })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren", persona: true })
      // The account's story persona is Tobin; Ana is cast in the story.
      yield* api.ChangeGenerationDefaults({ change: { persona: tobin.entityId } })
      const story = yield* api.CreateChat({ title: "Harbour" })
      yield* api.ChangeCast({ chatId: story.id, slotId: null, change: { _tag: "Join", entityId: ana.entityId } })
      // The workshop persona, made with the first workshop: the side chat plays it.
      const side = yield* api.CreateWorkshop({ attachTo: story.id })
      const made = (yield* api.GetWorkshopDefaults({})).persona!
      assert.notInclude([tobin.entityId, ana.entityId, wren.entityId], made)
      assert.deepStrictEqual((yield* stateOf(api, side)).playedByMe, [made])
      assert.notInclude((yield* stateOf(api, side)).participants, tobin.entityId)
      // Another workshop persona of the user's own: played beside the story too.
      yield* api.SetWorkshopPersona({ persona: wren.entityId })
      const beside = yield* api.CreateWorkshop({ attachTo: story.id })
      assert.deepStrictEqual((yield* stateOf(api, beside)).playedByMe, [wren.entityId])
      // The story persona, or a card in the story, as the workshop persona or chosen: none beside it.
      for (const persona of [tobin.entityId, ana.entityId]) {
        yield* api.SetWorkshopPersona({ persona })
        for (const workshop of [
          yield* api.CreateWorkshop({ attachTo: story.id }),
          yield* api.CreateWorkshop({ attachTo: story.id, persona })
        ]) {
          const state = yield* stateOf(api, workshop)
          assert.isEmpty(state.playedByMe)
          assert.notInclude(state.participants, persona)
        }
        // A workshop in its own right still plays the persona the user chose for workshops.
        assert.deepStrictEqual((yield* stateOf(api, yield* api.CreateWorkshop({}))).playedByMe, [persona])
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("starts with a chosen card and lets the cast swap it afterwards", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const { entityId } = yield* (yield* Writer).CreateEntity({
        userId: me.id,
        kind: "card",
        label: "Archivist",
        subtitle: "",
        doc: {
          ...cardDoc("Archivist", { description: "Keeps the library tidy.", first_mes: "Which shelf today?" })
        } as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const helper = { entityId: entityId as EntityId }
      const workshop = yield* api.CreateWorkshop({ card: helper.entityId })
      const state = yield* stateOf(api, workshop)
      assert.strictEqual(state.participants[0], helper.entityId)
      const path = yield* api.ReadPath({
        chatId: workshop.id,
        leafSlotId: workshop.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 5
      })
      assert.strictEqual(path.entries[0]?.version.content, "Which shelf today?")
      // The default assistant card is made too, for later workshops, and can replace it.
      const assistant = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Assistant")!
      for (const change of [
        { _tag: "Join", entityId: assistant.entityId },
        { _tag: "Leave", entityId: helper.entityId }
      ] as const)
        yield* api.ChangeCast({ chatId: workshop.id, slotId: null, change })
      const swapped = yield* stateOf(api, workshop)
      assert.include(swapped.participants, assistant.entityId)
      assert.notInclude(swapped.participants, helper.entityId)
      const missing = "00000000-0000-7000-8000-000000000000" as typeof helper.entityId
      assert.strictEqual(yield* outcome(api.CreateWorkshop({ card: missing })), "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("converts a story preset into a new workshop preset and leaves the original as it was", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const base = presetDoc(
        ["main", "charDescription", "personaDescription", "scenario", "chatHistory"].map((identifier) => ({
          identifier,
          content: identifier === "main" ? "Write vivid prose." : ""
        }))
      )
      const { ref } = yield* (yield* Writer).CreateEntity({
        userId: me.id,
        kind: "preset",
        label: "Story preset",
        subtitle: "",
        doc: base as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const made = yield* api.ConvertPresetToWorkshop({
        refId: ref.id,
        label: "Story preset (workshop)",
        choices: [{ identifier: "scenario", keep: true }],
        instructions: "Ask before renaming cards."
      })
      assert.notStrictEqual(made.id, ref.id)
      assert.strictEqual(made.label, "Story preset (workshop)")
      const converted = (yield* api.OpenEditor({ refId: made.id })).doc as unknown as PresetDoc
      const ids = converted.order.map((e) => e.identifier)
      for (const id of ["workspaceInstructions", "summaries", "skillsIndex", "cardSkills", "chatHistory"])
        assert.include(ids, id)
      assert.notInclude(ids, "personaDescription")
      assert.include(ids, "scenario")
      assert.strictEqual(
        converted.prompts.find((p) => p.identifier === "workspaceInstructions")?.content,
        "Ask before renaming cards."
      )
      const original = (yield* api.OpenEditor({ refId: ref.id })).doc as unknown as PresetDoc
      assert.deepStrictEqual(
        original.order.map((e) => e.identifier),
        base.order.map((e) => e.identifier)
      )
      assert.strictEqual(
        yield* outcome(
          api.ConvertPresetToWorkshop({
            refId: "00000000-0000-7000-8000-000000000000" as typeof ref.id,
            label: "Missing",
            choices: [],
            instructions: ""
          })
        ),
        "NotFound"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
