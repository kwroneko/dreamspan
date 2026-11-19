// GetCasts (night/tabperf): the casts at several positions of a fork in one request, each the
// cast GetCast reads there, with the cards read once for the positions that bind them alike.
// The chat's messages display with their own positions' casts; a page of them asked one each.
import { assert, describe, it } from "@effect/vitest"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

describe("GetCasts", () => {
  it.live("answers as GetCast does at each position, in their order", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = (yield* api.CreateCard({ label: "Ana", name: "Ana" })).entityId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const sam = (yield* api.CreateCard({ label: "Sam", name: "Sam" })).entityId
      const chat = yield* api.CreateChat({ title: "Casts" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ana } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [sam] } })
      const slots: Array<SlotId | null> = [null]
      let parent: SlotId | null = null
      for (const [i, content] of ["One.", "Two.", "Three."].entries()) {
        const sent: Effect.Success<ReturnType<typeof api.SendMessage>> = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content
        })
        if (sent._tag !== "Posted") throw new Error("unexpected queue")
        parent = sent.entry.slotId
        slots.push(parent)
        // Mira joins after the first message, and leaves after the second.
        if (i === 0)
          yield* api.ChangeCast({ chatId: chat.id, slotId: parent, change: { _tag: "Join", entityId: mira } })
        if (i === 1)
          yield* api.ChangeCast({ chatId: chat.id, slotId: parent, change: { _tag: "Leave", entityId: mira } })
      }
      const asked = [slots[3]!, null, slots[1]!, slots[2]!, slots[1]!]
      const batch = yield* api.GetCasts({ chatId: chat.id, slotIds: asked })
      assert.lengthOf(batch, asked.length)
      for (const [i, slotId] of asked.entries()) {
        const one = yield* api.GetCast({ chatId: chat.id, slotId })
        assert.deepStrictEqual(batch[i]!.slotId, slotId)
        assert.deepStrictEqual(batch[i]!.participants, one.participants)
        assert.deepStrictEqual(batch[i]!.playedByMe, one.playedByMe)
        assert.deepStrictEqual(batch[i]!.macroNames, one.macroNames)
        assert.deepStrictEqual(
          batch[i]!.cards.map((card) => card.entityId).sort(),
          one.cards.map((card) => card.entityId).sort()
        )
      }
      assert.deepStrictEqual(batch[1]!.participants, [ana])
      assert.deepStrictEqual(batch[2]!.participants, [ana, mira])
      assert.deepStrictEqual(yield* api.GetCasts({ chatId: chat.id, slotIds: [] }), [])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
