// The reads and changes the client's separate-context controls use (spec/CHARACTER-CONTEXT.md
// §9.2 units CU1–CU5): the Context setting, as the cast reports it and as This chat changes it.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { unknownVersions, viewOf } from "../src/db/inspectorContexts.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const card = (api: Api, name: string) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId } = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    return entityId as EntityId
  })

/** A synthetic three-character chat: Mira, Tobin and Wren, one message so far. */
const threeCharacters = Effect.gen(function* () {
  const api = yield* client()
  const mira = yield* card(api, "Mira")
  const tobin = yield* card(api, "Tobin")
  const wren = yield* card(api, "Wren")
  const started = yield* api.StartChat({
    cards: [mira, tobin, wren],
    persona: null,
    greeting: null,
    first: { _tag: "Send", content: "The inn's door creaks open.", speakerEntityId: null }
  })
  const me = yield* api.Whoami()
  return { api, mira, tobin, wren, started, userId: me.id as UserId }
})

describe("separate contexts in the client's reads", () => {
  it.live("the Context setting: the installed views, the chat's choice, and a change from a position on", () =>
    Effect.gen(function* () {
      const { api, started, userId } = yield* threeCharacters
      const at = { chatId: started.chat.id, slotId: started.entry.slotId }
      const before = yield* api.GetCast(at)
      assert.strictEqual(before.contextPerSpeaker, undefined)
      assert.deepStrictEqual(
        before.contextViews?.map((view) => view.id),
        ["shared", "separate"]
      )
      assert.strictEqual(before.contextViews?.[1]?.label, "Separate contexts")
      const after = yield* api.ChangeCast({ ...at, change: { _tag: "ContextPerSpeaker", view: "separate" } })
      assert.strictEqual(after.contextPerSpeaker, "separate")
      const reader = yield* Reader
      const state = foldState(yield* reader.StateEventsAt({ userId, chatId: at.chatId, slotId: at.slotId }))
      assert.strictEqual(state.contextPerSpeaker, "separate")
      // Before the message it was set at, the chat is still one shared context.
      assert.strictEqual((yield* api.GetCast({ chatId: at.chatId, slotId: null })).contextPerSpeaker, undefined)
      const back = yield* api.ChangeCast({ ...at, change: { _tag: "ContextPerSpeaker", view: "shared" } })
      assert.strictEqual(back.contextPerSpeaker, "shared")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("the Cast tab's Away and Narrator: away apart from Mute, and a narrator never away", () =>
    Effect.gen(function* () {
      const { api, started, mira, wren } = yield* threeCharacters
      const at = { chatId: started.chat.id, slotId: started.entry.slotId }
      const change = (c: Parameters<Api["ChangeCast"]>[0]["change"]) => api.ChangeCast({ ...at, change: c })
      const away = yield* change({ _tag: "Away", entityId: wren, away: true })
      assert.deepStrictEqual(away.away, [wren])
      assert.deepStrictEqual(away.absent, [])
      const narrator = yield* change({ _tag: "Role", entityId: mira, role: "narrator" })
      assert.deepStrictEqual(narrator.roles, { [mira]: "narrator" })
      // A narrator marked away isn't: it's never in or out of the scene.
      const both = yield* change({ _tag: "Away", entityId: mira, away: true })
      assert.deepStrictEqual(both.away, [wren])
      const back = yield* change({ _tag: "Away", entityId: wren, away: false })
      assert.strictEqual(back.away, undefined)
      const cleared = yield* change({ _tag: "Role", entityId: mira, role: null })
      assert.strictEqual(cleared.roles, undefined)
      assert.deepStrictEqual(cleared.away, [mira])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("the timeline's away marks, who set them, and Undo of the scene check's", () =>
    Effect.gen(function* () {
      const { api, started, mira, wren, userId } = yield* threeCharacters
      const writer = yield* Writer
      const chatId = started.chat.id
      const forkId = started.chat.currentForkId as ForkId
      const slotId = started.entry.slotId
      const reply = yield* writer.AppendMessage({
        userId,
        chatId,
        forkId,
        parentSlotId: slotId,
        branch: false,
        version: new NewVersion({
          speakerEntityId: mira,
          writer: "human",
          content: "*Mira sets down her cup.*",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        }),
        commitDraft: null
      })
      // The scene check judged that Wren left at the end of the user's line.
      const decision = yield* writer.AddStateEvent({
        userId,
        chatId,
        forkId,
        slotId,
        versionId: null,
        scope: null,
        data: { key: "away.set", value: { entity: wren, away: true, source: "decision" } }
      })
      yield* api.ChangeCast({
        chatId,
        forkId,
        slotId: reply.slotId,
        change: { _tag: "Away", entityId: mira, away: true }
      })
      const shape = (marks: ReadonlyArray<{ slotId: string; entityId: string; away: boolean; by: string }>) =>
        marks.map(({ slotId, entityId, away, by }) => ({ slotId, entityId, away, by }))
      const marks = yield* api.GetAwayMarks({ chatId, forkId, slotId: reply.slotId })
      assert.deepStrictEqual(shape(marks), [
        { slotId, entityId: wren, away: true, by: "decision" },
        { slotId: reply.slotId, entityId: mira, away: true, by: "user" }
      ])
      assert.strictEqual(marks[0]!.eventId, decision.id)
      // A user's mark isn't the scene check's: Undo refuses it.
      assert.isFalse(yield* api.UndoAwayMark({ chatId, forkId, eventId: marks[1]!.eventId }))
      assert.isTrue(yield* api.UndoAwayMark({ chatId, forkId, eventId: decision.id }))
      assert.deepStrictEqual(shape(yield* api.GetAwayMarks({ chatId, forkId, slotId: reply.slotId })), [
        { slotId, entityId: wren, away: false, by: "user" },
        { slotId: reply.slotId, entityId: mira, away: true, by: "user" }
      ])
      assert.isFalse(yield* api.UndoAwayMark({ chatId, forkId, eventId: decision.id }))
      assert.deepStrictEqual((yield* api.GetCast({ chatId, forkId, slotId: reply.slotId })).away, [mira])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

describe("the inspector's separate context", () => {
  const inputs = (more: object) => ({ speaker: "wren", cards: [], ...more })
  const knowers = [
    {
      key: "path",
      found: [
        { versionId: "v1", knowers: ["mira", "wren"] },
        { versionId: "v2", knowers: ["mira", "tobin"] },
        { versionId: "v3", knowers: null },
        { versionId: "v4", knowers: ["old-wren"] },
        { versionId: "v2", knowers: ["mira", "tobin"] }
      ]
    }
  ]
  it("is the viewer's, or a narrator's whole chat, or none in a shared context", () => {
    assert.deepStrictEqual(viewOf({ inputs: inputs({ viewer: "wren" }) }), { viewer: "wren", narrator: false })
    assert.deepStrictEqual(viewOf({ inputs: inputs({ presence: { narrators: ["wren"] } }) as never }), {
      viewer: "wren",
      narrator: true
    })
    assert.isNull(viewOf({ inputs: inputs({}) }))
  })
  it("lists what the viewer didn't know, by any of its identities, once each", () => {
    assert.deepStrictEqual(unknownVersions({ inputs: inputs({ viewer: "wren" }), sources: { knowers } }), ["v2", "v4"])
    assert.deepStrictEqual(
      unknownVersions({
        inputs: inputs({ viewer: "wren", viewerAliases: ["old-wren", "wren"] }),
        sources: { knowers }
      }),
      ["v2"]
    )
    assert.deepStrictEqual(unknownVersions({ inputs: inputs({}), sources: { knowers } }), [])
  })
})
