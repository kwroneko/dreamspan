import { assert, it } from "@effect/vitest"
import { ForkId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
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
    const branch = (yield* api.ListForks({ chatId })).find((f) => f.tipSlotId === divergent.entry.slotId)!
    yield* api.PinFork({ forkId: branch.id, pinned: true })
    yield* api.DeleteMessage({ slotId: divergent.entry.slotId })
    const pin = (yield* api.GetShellLibrary()).forks.find((f) => f.pinned)!
    assert.strictEqual(pin.leaf, start.chat.activeLeafSlotId)
    yield* api.PinFork({ forkId: ForkId.make(pin.forkId), pinned: false })
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
    yield* posted(
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
    // Opening another fork is the client's view alone (no SetActiveLeaf since forks): the current one stays.
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
    // The fork it's opened in, which the client names (without one, the current fork is meant).
    const older = (yield* api.ListForks({ chatId })).find((f) => f.tipSlotId === old.entry.slotId)!
    yield* api.Regenerate({ slotId: old.entry.slotId, forkId: older.id, expectedRowVersion: old.entry.rowVersion })
    assert.strictEqual((yield* api.GetShellLibrary()).forks.find((f) => f.current)!.leaf, old.entry.slotId)
  }).pipe(
    Effect.scoped,
    Effect.provide(
      serverLayer(testConfig({ dbWorkers: "bundle" }), fakeGenerator({ tokensPerSecond: 10000, tokens: 10 }))
    )
  )
)

it.live("a fork's row previews its tip as that fork shows it after a swipe made in it", () =>
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
    const older = (yield* api.ListForks({ chatId })).find((f) => f.tipSlotId === old.entry.slotId)!
    yield* api.Regenerate({ slotId: old.entry.slotId, forkId: older.id, expectedRowVersion: old.entry.rowVersion })
    // The new swipe is the older fork's alone (an override), and its row must show it, as the fork list does.
    const preview = () =>
      api
        .GetShellLibrary()
        .pipe(Effect.map((s) => s.forks.find((f) => f.chat.id === chatId && f.leaf === old.entry.slotId)!.preview))
    const excerpt = () =>
      api.ListForks({ chatId }).pipe(Effect.map((fs) => fs.find((f) => f.tipSlotId === old.entry.slotId)!.tipExcerpt))
    // Once the reply has its text: the fork list's excerpt is the fork's tip as it shows it.
    let shown = ["", ""] as [string, string]
    for (let tries = 0; tries < 100; tries++) {
      shown = [(yield* preview()).slice(0, 40), (yield* excerpt()).slice(0, 40)]
      if (shown[1] !== "" && shown[1] !== "Older fork" && shown[0] === shown[1]) break
      yield* Effect.sleep("50 millis")
    }
    assert.notStrictEqual(shown[1], "Older fork")
    assert.notStrictEqual(shown[1], "")
    assert.strictEqual(shown[0], shown[1])
  }).pipe(
    Effect.scoped,
    Effect.provide(
      serverLayer(testConfig({ dbWorkers: "bundle" }), fakeGenerator({ tokensPerSecond: 10000, tokens: 10 }))
    )
  )
)
