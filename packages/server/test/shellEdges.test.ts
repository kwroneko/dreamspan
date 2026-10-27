import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { Generator } from "../src/chat/Generator.ts"
import { layer as fakeGenerator } from "../src/dev/fakeGenerator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"

const layer = () => serverLayer(testConfig({ dbWorkers: "bundle" }), Generator.none)

it.live("a pinned divergent fork can be unpinned after deleting its only message", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const c = yield* api.CreateCard({ label: "Synthetic", name: "Synthetic" })
    const start = yield* api.StartChat({
      cards: [c.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Root", speakerEntityId: null }
    })
    const chatId = start.chat.id
    yield* posted(
      api.SendMessage({
        chatId,
        parentSlotId: start.chat.activeLeafSlotId,
        speakerEntityId: c.entityId,
        content: "Primary",
        branch: false
      })
    )
    const divergent = yield* posted(
      api.SendMessage({
        chatId,
        parentSlotId: start.chat.activeLeafSlotId,
        speakerEntityId: c.entityId,
        content: "Pinned divergent",
        branch: true
      })
    )
    yield* api.SetChatPin({ chatId, leaf: divergent.entry.slotId, pinned: true })
    yield* api.DeleteMessage({ slotId: divergent.entry.slotId })
    const pin = (yield* api.GetShellLibrary()).forks.find((f) => f.pinned)!
    assert.strictEqual(pin.leaf, start.chat.activeLeafSlotId)
    yield* api.SetChatPin({ chatId, leaf: pin.leaf, forkId: pin.forkId, pinned: false })
    assert.isFalse((yield* api.GetShellLibrary()).forks.some((f) => f.pinned))
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

it.live("deleting the current tip resolves on its own surviving path after browsing another fork", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const c = yield* api.CreateCard({ label: "Synthetic", name: "Synthetic" })
    const start = yield* api.StartChat({
      cards: [c.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Root", speakerEntityId: null }
    })
    const chatId = start.chat.id
    const primary = yield* posted(
      api.SendMessage({
        chatId,
        parentSlotId: start.chat.activeLeafSlotId,
        speakerEntityId: c.entityId,
        content: "Primary",
        branch: false
      })
    )
    const fork = yield* posted(
      api.SendMessage({
        chatId,
        parentSlotId: start.chat.activeLeafSlotId,
        speakerEntityId: c.entityId,
        content: "Other road",
        branch: true
      })
    )
    const tip = yield* posted(
      api.SendMessage({
        chatId,
        parentSlotId: fork.entry.slotId,
        speakerEntityId: c.entityId,
        content: "Current tip",
        branch: false
      })
    )
    const me = yield* api.Whoami()
    yield* (yield* Writer).SetActiveLeaf({
      userId: me.id,
      chatId,
      slotId: primary.entry.slotId,
      expectedRowVersion: (yield* api.GetChat({ chatId })).rowVersion
    })
    yield* api.DeleteMessage({ slotId: tip.entry.slotId })
    const current = (yield* api.GetShellLibrary()).forks.find((f) => f.current)!
    assert.strictEqual(current.leaf, fork.entry.slotId)
  }).pipe(Effect.scoped, Effect.provide(layer()))
)

it.live("regenerating a reply on an older fork makes that fork current", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const c = yield* api.CreateCard({ label: "Synthetic", name: "Synthetic" })
    const start = yield* api.StartChat({
      cards: [c.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Root", speakerEntityId: null }
    })
    const chatId = start.chat.id
    const old = yield* posted(
      api.SendMessage({
        chatId,
        parentSlotId: start.chat.activeLeafSlotId,
        speakerEntityId: c.entityId,
        content: "Older fork",
        branch: false
      })
    )
    yield* posted(
      api.SendMessage({
        chatId,
        parentSlotId: start.chat.activeLeafSlotId,
        speakerEntityId: c.entityId,
        content: "Newer fork",
        branch: true
      })
    )
    yield* api.Regenerate({ slotId: old.entry.slotId, expectedRowVersion: old.entry.rowVersion })
    assert.strictEqual((yield* api.GetShellLibrary()).forks.find((f) => f.current)!.leaf, old.entry.slotId)
  }).pipe(
    Effect.scoped,
    Effect.provide(
      serverLayer(testConfig({ dbWorkers: "bundle" }), fakeGenerator({ tokensPerSecond: 10000, tokens: 10 }))
    )
  )
)
