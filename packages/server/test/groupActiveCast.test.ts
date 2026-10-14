import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

describe("groups use the active cast", () => {
  it.live("restoring played-by-me to empty restores both characters on the group tile", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const chat = yield* api.CreateChat({ title: "Two characters" })
      for (const entityId of [ana, mira])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [ana] } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [] } })
      const cast = yield* api.GetCast({ chatId: chat.id, slotId: null })
      assert.deepStrictEqual(cast.playedByMe, [])
      const groups = yield* api.ListChatGroups()
      assert.lengthOf(groups, 1, "both characters now belong on a group tile")
      assert.deepStrictEqual(
        groups[0]!.members.map((m) => m.entityId),
        [ana, mira]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("leaving a two-character chat removes its group tile", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const chat = yield* api.CreateChat({ title: "Former group" })
      for (const entityId of [ana, mira])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Leave", entityId: mira } })
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: null })).participants, [ana])
      assert.lengthOf(yield* api.ListChatGroups(), 0, "one current character is not a group")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("joining on a sibling branch does not put the sibling-only member in the active group", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const tobin = (yield* api.CreateCard({ label: "Tobin", name: "Tobin" })).entityId
      const chat = yield* api.CreateChat({ title: "Branch group" })
      for (const entityId of [ana, mira])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
      const root = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Root." })
      assert.strictEqual(root._tag, "Posted")
      if (root._tag !== "Posted") return
      const sibling = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: false,
        content: "Sibling."
      })
      assert.strictEqual(sibling._tag, "Posted")
      if (sibling._tag !== "Posted") return
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: sibling.entry.slotId,
        change: { _tag: "Join", entityId: tobin }
      })
      const active = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: root.entry.slotId,
        branch: true,
        content: "Active."
      })
      assert.strictEqual(active._tag, "Posted")
      if (active._tag !== "Posted") return
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: active.entry.slotId })).participants, [
        ana,
        mira
      ])
      const group = (yield* api.ListChatGroups())[0]!
      assert.deepStrictEqual(
        group.members.map((m) => m.entityId),
        [ana, mira]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
