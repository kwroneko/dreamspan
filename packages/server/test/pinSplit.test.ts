import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"

it.live("branch pins stay local, chat pins are unique and open the current branch", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Pin fixture", name: "Pin fixture" })
    const { chat } = yield* api.StartChat({
      cards: [card.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Synthetic beginning", speakerEntityId: null }
    })
    const original = (yield* api.ListForks({ chatId: chat.id }))[0]!
    const make = (name: string) =>
      Effect.gen(function* () {
        const { fork } = yield* api.CreateFork({
          chatId: chat.id,
          fromForkId: original.id,
          atSlotId: original.tipSlotId
        })
        yield* api.NameFork({ forkId: fork.id, name })
        return fork
      })
    const first = yield* make("First pin")
    const second = yield* make("Second pin")
    const named = yield* make("Named")
    yield* api.PinFork({ forkId: first.id, pinned: true })
    yield* api.PinFork({ forkId: second.id, pinned: true })
    yield* posted(
      api.SendMessage({
        chatId: chat.id,
        forkId: first.id,
        parentSlotId: first.tipSlotId,
        content: "Newest pinned message",
        branch: false
      })
    )
    yield* posted(
      api.SendMessage({
        chatId: chat.id,
        forkId: named.id,
        parentSlotId: named.tipSlotId,
        content: "Newest named message",
        branch: false
      })
    )
    const view = {
      entity: null,
      chat: chat.id,
      search: "",
      sort: "recent" as const,
      sections: [
        { id: "pinned" as const, limit: 20 },
        { id: "pinnedBranches" as const, limit: 20 },
        { id: "peers" as const, limit: 20 },
        { id: "other" as const, limit: 20 }
      ]
    }
    let lists = (yield* api.GetShellForks(view)).sections
    assert.strictEqual(lists[0]!.total, 0)
    assert.deepStrictEqual(
      lists[1]!.rows.map((f) => f.forkId),
      [first.id, second.id]
    )
    assert.deepStrictEqual(
      lists[2]!.rows.map((f) => f.forkId),
      [named.id]
    )
    assert.deepStrictEqual(
      lists[3]!.rows.map((f) => f.forkId),
      [original.id]
    )
    for (let i = 0; i < 2; i++) yield* api.SetChatPin({ chatId: chat.id, leaf: null, pinned: true })
    lists = (yield* api.GetShellForks(view)).sections
    assert.strictEqual(lists[0]!.total, 1)
    assert.strictEqual(lists[0]!.rows[0]!.forkId, named.id)
    assert.isTrue(lists[0]!.rows[0]!.chatPinned)
    assert.isFalse(lists[0]!.rows[0]!.pinned)
    yield* api.PinFork({ forkId: first.id, pinned: false })
    assert.strictEqual((yield* api.GetShellForks(view)).sections[0]!.total, 1)
    yield* api.SetChatPin({ chatId: chat.id, leaf: null, pinned: false })
    yield* api.SetChatPin({ chatId: chat.id, leaf: null, pinned: false })
    lists = (yield* api.GetShellForks(view)).sections
    assert.strictEqual(lists[0]!.total, 0)
    assert.deepStrictEqual(
      lists[1]!.rows.map((f) => f.forkId),
      [second.id]
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dbWorkers: "bundle" }), Generator.none)))
)
