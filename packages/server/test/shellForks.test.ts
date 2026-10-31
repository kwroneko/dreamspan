// The shell read in parts (db/shellReads.ts): the cards alone (GetShellCards) and the fork
// rows a screen shows (GetShellForks), each list's first rows and its size. They agree with
// the whole read (GetShellLibrary), and a write is never hidden by the reader's kept
// computation.
import type { Chat } from "@rp/shared/chat.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"

const layer = () => serverLayer(testConfig({ dbWorkers: "bundle" }), Generator.none)

describe("the shell read in parts", () => {
  it.live("pages each list, searches, and answers a write at once", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const aria = yield* api.CreateCard({ label: "Aria", name: "Aria" })
      const bryn = yield* api.CreateCard({ label: "Bryn", name: "Bryn" })
      const unused = yield* api.CreateCard({ label: "Unused", name: "Unused" })
      const start = (cards: ReadonlyArray<typeof aria.entityId>) =>
        api.StartChat({
          cards,
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Start.", speakerEntityId: null }
        })
      const say = (chat: Chat, speakerEntityId: typeof aria.entityId) =>
        posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            speakerEntityId,
            content: "A synthetic turn.",
            branch: false
          })
        )
      const solo: Array<Chat["id"]> = []
      for (let i = 0; i < 5; i++) {
        const started = yield* start([aria.entityId])
        yield* say(started.chat, aria.entityId)
        solo.push(started.chat.id)
        yield* Effect.sleep("2 millis")
      }
      const group = yield* start([aria.entityId, bryn.entityId])
      const bryns = yield* say(group.chat, bryn.entityId)

      const view = {
        entity: null,
        chat: null,
        search: "",
        sort: "recent" as const,
        sections: [{ id: "chats" as const, limit: 2 }]
      }
      const all = (yield* api.GetShellForks(view)).sections[0]!
      // Six chats, newest first, two shown.
      assert.strictEqual(all.total, 6)
      assert.deepStrictEqual(
        all.rows.map((f) => f.chat.id),
        [group.chat.id, solo[4]]
      )
      const whole = yield* api.GetShellLibrary()
      assert.deepStrictEqual(
        all.rows.map((f) => f.forkId),
        whole.forks.slice(0, 2).map((f) => f.forkId)
      )

      // A card's lists by how it is in each chat, its people described once.
      const ariaView = yield* api.GetShellForks({
        ...view,
        entity: aria.entityId,
        sections: [
          { id: "just", limit: 100 },
          { id: "with", limit: 100 },
          { id: "was", limit: 100 },
          { id: "card", limit: 3 }
        ]
      })
      const [just, withOthers, was, card] = ariaView.sections
      assert.strictEqual(just!.total, 5)
      assert.deepStrictEqual(
        withOthers!.rows.map((f) => f.chat.id),
        [group.chat.id]
      )
      assert.strictEqual(was!.total, 0)
      assert.strictEqual(card!.total, 6)
      assert.strictEqual(card!.rows.length, 3)
      assert.sameMembers(
        ariaView.people.map((c) => c.entityId),
        [aria.entityId, bryn.entityId]
      )

      // Search by a cast member's name.
      const found = yield* api.GetShellForks({ ...view, search: "bry", sections: [{ id: "chats", limit: 100 }] })
      assert.deepStrictEqual(
        found.sections[0]!.rows.map((f) => f.chat.id),
        [group.chat.id]
      )
      // Only the chats asked for, and a chat's own forks.
      const listed = yield* api.GetShellForks({
        ...view,
        chats: [solo[0]!],
        sections: [{ id: "current", limit: 10 }]
      })
      assert.deepStrictEqual(
        listed.sections[0]!.rows.map((f) => f.chat.id),
        [solo[0]]
      )

      // The cards alone: Recent, what a tile opens, and none for a card in no chat.
      const cards = yield* api.GetShellCards()
      const of = (id: typeof aria.entityId) => cards.cards.find((c) => c.card.entityId === id)!
      assert.strictEqual(of(aria.entityId).recentAt, whole.forks[0]!.recentAt)
      assert.isNull(of(unused.entityId).recentAt)
      assert.isNull(of(unused.entityId).open)
      assert.deepStrictEqual(of(bryn.entityId).open, {
        chatId: group.chat.id,
        forkId: whole.forks[0]!.forkId,
        leaf: bryns.entry.slotId,
        slot: bryns.entry.slotId
      })
      assert.deepStrictEqual(
        cards.cards.map((c) => c.card.entityId),
        whole.cards.map((c) => c.card.entityId)
      )

      // A write right after a read: the next read has it (the worker's kept result is stale).
      const first = whole.forks.find((f) => f.chat.id === solo[0])!
      yield* api.SetChatPin({ chatId: solo[0]!, leaf: first.leaf, forkId: first.forkId, pinned: true })
      const pinned = yield* api.GetShellForks({ ...view, sections: [{ id: "pinned", limit: 10 }] })
      assert.deepStrictEqual(
        pinned.sections[0]!.rows.map((f) => f.chat.id),
        [solo[0]]
      )
      const later = yield* start([unused.entityId])
      assert.strictEqual(
        (yield* api.GetShellCards()).cards.find((c) => c.card.entityId === unused.entityId)!.open?.chatId,
        later.chat.id
      )
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})
