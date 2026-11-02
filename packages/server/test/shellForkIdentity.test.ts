import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"

it.live("card swaps keep user-played speaking turns out of shell activity", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "User-played pilot", name: "Pilot" })
    const start = yield* api.StartChat({
      cards: [card.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Before playing this card", speakerEntityId: null }
    })
    const original = (yield* api.ListForks({ chatId: start.chat.id }))[0]!
    yield* api.ChangeCast({
      chatId: start.chat.id,
      forkId: original.id,
      slotId: original.tipSlotId,
      change: { _tag: "PlayedByMe", entityIds: [card.entityId] }
    })
    const turn = yield* posted(
      api.SendMessage({
        chatId: start.chat.id,
        forkId: original.id,
        parentSlotId: original.tipSlotId,
        speakerEntityId: card.entityId,
        content: "A user-played turn",
        branch: false
      })
    )
    const peer = (yield* api.CreateFork({
      chatId: start.chat.id,
      fromForkId: original.id,
      atSlotId: turn.entry.slotId
    })).fork
    const copy = yield* api.ForkCardForChat({
      chatId: start.chat.id,
      forkId: original.id,
      slotId: turn.entry.slotId,
      entityId: card.entityId,
      name: "Copied pilot",
      nickname: "",
      characterVersion: "1"
    })
    const secondTurn = yield* posted(
      api.SendMessage({
        chatId: start.chat.id,
        forkId: original.id,
        parentSlotId: turn.entry.slotId,
        speakerEntityId: copy.entityId,
        content: "Still played by the user",
        branch: false
      })
    )
    const secondCopy = yield* api.ForkCardForChat({
      chatId: start.chat.id,
      forkId: original.id,
      slotId: secondTurn.entry.slotId,
      entityId: copy.entityId,
      name: "Twice copied pilot",
      nickname: "",
      characterVersion: "2"
    })
    const rows = (yield* api.GetShellLibrary()).forks
    assert.isEmpty(rows.find((f) => f.forkId === original.id)!.activity)
    assert.isEmpty(rows.find((f) => f.forkId === peer.id)!.activity)
    for (const entityId of [card.entityId, copy.entityId, secondCopy.entityId])
      assert.isNull((yield* api.GetShellLibrary()).cards.find((c) => c.card.entityId === entityId)!.card.lastMessageAt)
    const modelTurn = yield* posted(
      api.SendMessage({
        chatId: start.chat.id,
        forkId: original.id,
        parentSlotId: secondTurn.entry.slotId,
        speakerEntityId: secondCopy.entityId,
        content: "Now a character turn",
        branch: false
      })
    )
    yield* api.ChangeCast({
      chatId: start.chat.id,
      forkId: original.id,
      slotId: modelTurn.entry.slotId,
      change: { _tag: "PlayedByMe", entityIds: [] }
    })
    assert.deepEqual(
      (yield* api.GetShellLibrary()).forks
        .find((f) => f.forkId === original.id)!
        .activity.map((a) => [a.entityId, a.slot]),
      [[secondCopy.entityId, modelTurn.entry.slotId]]
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dbWorkers: "bundle" }), Generator.none)))
)

it.live("shell rows retain interior checkpoints, same-tip peers and empty forks with their own views", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const a = yield* api.CreateCard({ label: "Shell Aria", name: "Shell Aria" })
    const b = yield* api.CreateCard({ label: "Shell Bryn", name: "Shell Bryn" })
    const start = yield* api.StartChat({
      cards: [a.entityId, b.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Shared root", speakerEntityId: a.entityId }
    })
    const chatId = start.chat.id
    const original = (yield* api.ListForks({ chatId }))[0]!
    const checkpoint = (yield* api.CreateFork({ chatId, fromForkId: original.id, atSlotId: original.tipSlotId })).fork
    yield* api.NameFork({ forkId: checkpoint.id, name: "Interior checkpoint" })
    const continuation = yield* posted(
      api.SendMessage({
        chatId,
        forkId: original.id,
        parentSlotId: original.tipSlotId,
        speakerEntityId: b.entityId,
        content: "Only on original",
        branch: false
      })
    )
    const peer = (yield* api.CreateFork({ chatId, fromForkId: checkpoint.id, atSlotId: checkpoint.tipSlotId })).fork
    yield* api.NameFork({ forkId: peer.id, name: "Same-tip peer" })
    yield* api.SetChatPin({ chatId, forkId: peer.id, leaf: peer.tipSlotId, pinned: true })
    yield* api.ChangeCast({
      chatId,
      forkId: peer.id,
      slotId: peer.tipSlotId,
      change: { _tag: "Leave", entityId: a.entityId }
    })
    const entry = (yield* api.ReadPath({
      chatId,
      forkId: peer.id,
      leafSlotId: peer.tipSlotId,
      range: { _tag: "Bottom" },
      limit: 10
    })).entries[0]!
    yield* api.WriteVersion({
      slotId: entry.slotId,
      forkId: peer.id,
      content: "Peer selection",
      expectedRowVersion: entry.rowVersion
    })
    const empty = (yield* api.CreateFork({ chatId, fromForkId: original.id, atSlotId: null })).fork
    yield* api.NameFork({ forkId: empty.id, name: "Before first message" })
    let rows = (yield* api.GetShellLibrary()).forks.filter((f) => f.chat.id === chatId)
    assert.sameMembers(
      rows.map((f) => f.forkId),
      [original.id, checkpoint.id, peer.id, empty.id]
    )
    const check = rows.find((f) => f.forkId === checkpoint.id)!
    const other = rows.find((f) => f.forkId === peer.id)!
    assert.strictEqual(check.name, "Interior checkpoint")
    assert.strictEqual(check.leaf, original.tipSlotId)
    assert.strictEqual(check.preview, "Shared root")
    assert.isFalse(check.pinned)
    assert.isTrue(other.pinned)
    assert.strictEqual(other.name, "Same-tip peer")
    assert.strictEqual(other.preview, "Peer selection")
    assert.strictEqual(check.messages, 1)
    assert.include(check.cast, a.entityId)
    assert.notInclude(other.cast, a.entityId)
    assert.include(other.departed, a.entityId)
    assert.strictEqual(other.activity.find((x) => x.entityId === a.entityId)!.category, "was")
    assert.strictEqual(rows.find((f) => f.current)!.forkId, empty.id)
    assert.strictEqual(rows.find((f) => f.forkId === empty.id)!.leaf, null)
    assert.strictEqual(rows.find((f) => f.forkId === original.id)!.leaf, continuation.entry.slotId)
    const unrelated = yield* api.CreateChat({ title: "Unrelated synthetic chat" })
    const foreign = (yield* api.ListForks({ chatId: unrelated.id }))[0]!
    assert.strictEqual(
      (yield* Effect.flip(api.SetChatPin({ chatId, forkId: foreign.id, leaf: null, pinned: true })))._tag,
      "NotFound"
    )
    // Deletion is local even when the two forks have the exact same endpoint.
    yield* api.DeleteMessage({ slotId: peer.tipSlotId!, forkId: peer.id })
    rows = (yield* api.GetShellLibrary()).forks.filter((f) => f.chat.id === chatId)
    assert.strictEqual(rows.find((f) => f.forkId === peer.id)!.leaf, null)
    assert.strictEqual(rows.find((f) => f.forkId === peer.id)!.preview, "")
    assert.strictEqual(rows.find((f) => f.forkId === peer.id)!.messages, 0)
    assert.strictEqual(rows.find((f) => f.forkId === checkpoint.id)!.preview, "Shared root")
    yield* api.SetChatPin({ chatId, forkId: peer.id, leaf: null, pinned: false })
    yield* api.DeleteFork({ forkId: peer.id })
    assert.notInclude(
      (yield* api.GetShellLibrary()).forks.map((f) => f.forkId),
      peer.id
    )
    const c = yield* api.ForkCardForChat({
      chatId,
      forkId: original.id,
      slotId: continuation.entry.slotId,
      entityId: b.entityId,
      name: "Shell Cora",
      nickname: "",
      characterVersion: "1"
    })
    const swapped = (yield* api.GetShellLibrary()).forks.find((f) => f.forkId === original.id)!
    assert.include(swapped.joined, b.entityId)
    assert.notInclude(swapped.joined, c.entityId, "a swap alone configures the next turn; no version used Cora yet")
    assert.include(swapped.departed, b.entityId)
    assert.include(swapped.cast, c.entityId)
    assert.strictEqual(swapped.activity.find((x) => x.entityId === b.entityId)!.slot, continuation.entry.slotId)
    assert.strictEqual(swapped.activity.find((x) => x.entityId === b.entityId)!.category, "was")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dbWorkers: "bundle" }), Generator.none)))
)
