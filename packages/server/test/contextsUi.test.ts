// The reads and changes the client's separate-context controls use (spec/CHARACTER-CONTEXT.md
// §9.2 units CU1–CU5): the Context setting, as the cast reports it and as This chat changes it.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
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
})
