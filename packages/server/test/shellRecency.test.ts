// A chat's Recent across its branches (db/shellReads.ts): the latest activity in any of its
// forks, branching included, so the chat the user just branched stays on top instead of
// dropping to the branch point's date. Lists of chats show each chat once, by its current
// fork, with its chat's name and how many branches it has; a chat's own lists stay per fork.
import type { Chat } from "@dreamspan/shared/chat.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { ALICE_MAIN, stFolder } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const layer = () => serverLayer(testConfig({ dbWorkers: "bundle" }), Generator.none)

describe("a chat's recency across its branches", () => {
  it.live("branching moves the chat to the top, and it's listed once with its branch count", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const aria = yield* api.CreateCard({ label: "Aria", name: "Aria" })
      const bryn = yield* api.CreateCard({ label: "Bryn", name: "Bryn" })
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
      const older = yield* start([aria.entityId])
      yield* say(older.chat, aria.entityId)
      yield* Effect.sleep("5 millis")
      const newer = yield* start([aria.entityId, bryn.entityId])
      yield* say(newer.chat, bryn.entityId)

      const view = {
        entity: null,
        chat: null,
        search: "",
        sort: "recent" as const,
        sections: [{ id: "chats" as const, limit: 10 }]
      }
      const before = (yield* api.GetShellForks(view)).sections[0]!
      assert.deepStrictEqual(
        before.rows.map((f) => f.chat.id),
        [newer.chat.id, older.chat.id]
      )

      // Branch the older chat at its first message, which predates everything in the newer one.
      yield* Effect.sleep("5 millis")
      const path = yield* api.ReadPath({
        chatId: older.chat.id,
        leafSlotId: older.chat.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 10
      })
      const made = yield* api.CreateFork({
        chatId: older.chat.id,
        fromForkId: null,
        atSlotId: path.entries[0]!.slotId,
        name: "From #1"
      })
      assert.strictEqual(made.fork.name, "From #1")

      const after = (yield* api.GetShellForks(view)).sections[0]!
      // Still two chats: the branched one once, on top, by its new current fork.
      assert.strictEqual(after.total, 2)
      assert.deepStrictEqual(
        after.rows.map((f) => f.chat.id),
        [older.chat.id, newer.chat.id]
      )
      const row = after.rows[0]!
      assert.strictEqual(row.forkId, made.fork.id)
      assert.isTrue(row.current)
      assert.strictEqual(row.branches, 2)
      assert.strictEqual(row.name, "From #1")
      assert.match(row.chatName, /^Aria/)
      assert.strictEqual(row.recentAt, made.fork.createdAt)
      assert.strictEqual(row.chatRecentAt, made.fork.createdAt)
      assert.strictEqual(after.rows[1]!.branches, 1)

      // The card's lists show the chat once too; the chat's own lists keep both forks.
      const card = yield* api.GetShellForks({
        ...view,
        entity: aria.entityId,
        sections: [
          { id: "card", limit: 10 },
          { id: "just", limit: 10 }
        ]
      })
      assert.deepStrictEqual(
        card.sections[0]!.rows.map((f) => f.chat.id),
        [older.chat.id, newer.chat.id]
      )
      // Aria spoke only before the branch point: "Just Aria" has the chat by the fork she spoke in.
      assert.deepStrictEqual(
        card.sections[1]!.rows.map((f) => f.forkId),
        [older.chat.currentForkId!]
      )
      const own = yield* api.GetShellForks({ ...view, chat: older.chat.id, sections: [{ id: "all", limit: 10 }] })
      assert.strictEqual(own.sections[0]!.total, 2)

      // Its card's Recent counts the branching too.
      const cards = yield* api.GetShellCards()
      const ariaCard = cards.cards.find((c) => c.card.entityId === aria.entityId)!
      assert.strictEqual(ariaCard.recentAt, made.fork.createdAt)

      // Found by the chat's name, not only by the branch's.
      const found = yield* api.GetShellForks({ ...view, search: "aria" })
      assert.include(
        found.sections[0]!.rows.map((f) => f.chat.id),
        older.chat.id
      )
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
  it.live("an ST branch file merged into its chat keeps the chat's ST dates", () =>
    Effect.gen(function* () {
      const started = Date.now()
      const { api } = yield* importStFolder(stFolder("ST/data/default-user/"))
      const all = yield* api.GetShellForks({
        entity: null,
        chat: null,
        search: "",
        sort: "recent",
        sections: [{ id: "chats", limit: 50 }]
      })
      // Alice's chat has her main file and its "Branch #1": two forks, the second made by the
      // import now, which is not the user's activity in it.
      const alice = all.sections[0]!.rows.find((f) => f.chatName.startsWith("Alice") && f.branches === 2)
      assert.isDefined(alice, ALICE_MAIN)
      assert.isBelow(alice!.chatRecentAt, started)
      const own = yield* api.GetShellForks({
        entity: null,
        chat: alice!.chat.id,
        search: "",
        sort: "recent",
        sections: [{ id: "all", limit: 10 }]
      })
      assert.strictEqual(own.sections[0]!.total, 2)
      for (const fork of own.sections[0]!.rows) assert.isBelow(fork.recentAt, started)
      const cards = yield* api.GetShellCards()
      for (const card of cards.cards) if (card.recentAt !== null) assert.isBelow(card.recentAt, started)
    }).pipe(Effect.scoped, Effect.provide(layer()))
  )
})
