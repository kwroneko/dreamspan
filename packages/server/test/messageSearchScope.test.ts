// SearchMessages and CountMessages in the chats the Chats tab's filter shows, of one character's
// chats, in each sort (api/textSearch.ts, db/messageSearch.ts): the filter and the scope narrow
// the reader's query, the Chat sort lists chats by name (Z to A reversed) and pages on from its
// cursor, and the count says how many messages in how many chats.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import {
  type MessageCursor,
  type MessageSearchPage,
  type MessageSort,
  messageCountText
} from "@dreamspan/shared/messageSearch.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id
  const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
  const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
  const chats: Record<string, ChatId> = {}
  // Started in this order, so Newest lists them the other way round.
  for (const [name, cards] of [
    ["Zulu solo", [mira.entityId]],
    ["Alpha pair", [mira.entityId, wren.entityId]],
    ["Middle wren", [wren.entityId]]
  ] as const) {
    const started = yield* api.StartChat({
      cards,
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: `The lantern in ${name}.`, speakerEntityId: null }
    })
    yield* api.RenameChat({ chatId: started.chat.id, name })
    chats[name] = started.chat.id
  }
  yield* api.SetChatPin({ chatId: chats["Zulu solo"]!, leaf: null, pinned: true })
  const names = (hits: ReadonlyArray<{ readonly chatName: string }>) => hits.map((hit) => hit.chatName)
  return { api, userId, mira: mira.entityId, wren: wren.entityId, chats, names }
})

describe("message search in a filter, a character's chats and each sort", () => {
  it.effect("narrows the search to the chats the filter shows and the character's", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const found = (payload: Partial<Parameters<typeof f.api.SearchMessages>[0]>) =>
        f.api
          .SearchMessages({ text: "lantern", cursor: null, sort: "chat", ...payload })
          .pipe(Effect.map((page) => f.names(page.hits)))
      assert.deepStrictEqual(yield* found({}), ["Alpha pair", "Middle wren", "Zulu solo"])
      assert.deepStrictEqual(yield* found({ entity: f.mira }), ["Alpha pair", "Zulu solo"])
      assert.deepStrictEqual(yield* found({ entity: f.wren }), ["Alpha pair", "Middle wren"])
      assert.deepStrictEqual(yield* found({ filter: "solo" }), ["Middle wren", "Zulu solo"])
      assert.deepStrictEqual(yield* found({ filter: "groups" }), ["Alpha pair"])
      assert.deepStrictEqual(yield* found({ filter: "pinned" }), ["Zulu solo"])
      assert.deepStrictEqual(yield* found({ filter: "workshops" }), [])
      assert.deepStrictEqual(yield* found({ filter: "solo", entity: f.wren }), ["Middle wren"])
      // Best match, the default, in the scope too.
      assert.sameMembers(
        f.names((yield* f.api.SearchMessages({ text: "lantern", cursor: null, entity: f.mira })).hits),
        ["Alpha pair", "Zulu solo"]
      )
      const count = (payload: Partial<Parameters<typeof f.api.CountMessages>[0]>) =>
        f.api.CountMessages({ text: "lantern", ...payload })
      assert.deepStrictEqual(yield* count({}), { messages: 3, chats: 3, more: false })
      assert.deepStrictEqual(yield* count({ entity: f.mira }), { messages: 2, chats: 2, more: false })
      assert.deepStrictEqual(yield* count({ filter: "groups" }), { messages: 1, chats: 1, more: false })
      assert.deepStrictEqual(yield* count({ filter: "pinned", entity: f.wren }), {
        messages: 0,
        chats: 0,
        more: false
      })
      assert.deepStrictEqual(yield* f.api.CountMessages({ text: "nowhere" }), { messages: 0, chats: 0, more: false })
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("lists by each sort, the Chat sort by name either way", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const order = (sort: MessageSort, reversed = false) =>
        f.api
          .SearchMessages({ text: "lantern", cursor: null, sort, reversed })
          .pipe(Effect.map((page) => f.names(page.hits)))
      assert.deepStrictEqual(yield* order("newest"), ["Middle wren", "Alpha pair", "Zulu solo"])
      assert.deepStrictEqual(yield* order("oldest"), ["Zulu solo", "Alpha pair", "Middle wren"])
      assert.deepStrictEqual(yield* order("chat"), ["Alpha pair", "Middle wren", "Zulu solo"])
      assert.deepStrictEqual(yield* order("chat", true), ["Zulu solo", "Middle wren", "Alpha pair"])
      assert.sameMembers(yield* order("best"), ["Middle wren", "Alpha pair", "Zulu solo"])
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("pages each sort on from its cursor, every message once", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const reader = yield* Reader
      const order = [f.chats["Alpha pair"]!, f.chats["Middle wren"]!, f.chats["Zulu solo"]!]
      for (const [sort, expected] of [
        ["chat", ["Alpha pair", "Middle wren", "Zulu solo"]],
        ["newest", ["Middle wren", "Alpha pair", "Zulu solo"]],
        ["oldest", ["Zulu solo", "Alpha pair", "Middle wren"]]
      ] as const) {
        const seen: Array<string> = []
        let cursor: MessageCursor | null = null
        for (let page = 0; page < 5; page++) {
          const read: MessageSearchPage = yield* reader.SearchMessages({
            userId: f.userId,
            text: "lantern",
            cursor,
            limit: 1,
            sort,
            chats: order
          })
          seen.push(...f.names(read.hits))
          cursor = read.next
          if (cursor === null) break
        }
        assert.deepStrictEqual(seen, [...expected], sort)
      }
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it("says the count in words, capped", () => {
    assert.strictEqual(messageCountText({ messages: 128, chats: 14, more: false }), "128 messages in 14 chats")
    assert.strictEqual(messageCountText({ messages: 1, chats: 1, more: false }), "1 message in 1 chat")
    assert.strictEqual(messageCountText({ messages: 1000, chats: 40, more: true }), "1,000+ messages")
  })
})
