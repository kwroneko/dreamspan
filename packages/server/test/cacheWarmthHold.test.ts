// The cache estimate's holds and its reuse by a read of the next context (chat/CacheWarmth.ts):
// estimates wait while a reply is prepared or written, and a read takes the pushed estimate
// only while nothing changed since. Every change reaches the service the same two ways, as a
// published chat event (an edit, a delete, a branch, a swipe, a summary) or a refresh of the
// user's chats (a lorebook, a preset, a model), and both are covered here.
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { CacheWarmth } from "../src/chat/CacheWarmth.ts"
import { ChatHub } from "../src/chat/ChatHub.ts"
import { Reader } from "../src/db/Database.ts"
import { eventually } from "./support/generation.ts"

const user = "owner" as UserId
const chatId = "chat-1" as ChatId
const fork = "fork-1" as ForkId

const fixture = () => {
  const state = { calls: 0, leaf: "leaf-1", slow: 0 }
  const reader = Layer.succeed(Reader)({
    CacheWarmth: ({ leafSlotId }: { leafSlotId?: string | null }) =>
      Effect.gen(function* () {
        state.calls++
        if (state.slow > 0) yield* Effect.sleep(`${state.slow} millis`)
        return {
          warmth: null,
          leafSlotId: leafSlotId ?? state.leaf,
          forkId: fork,
          historyStart: { slotId: null, depth: state.calls },
          summarizedThrough: null
        }
      })
  } as unknown as Reader["Service"])
  const layer = CacheWarmth.layer.pipe(Layer.provideMerge(ChatHub.layerWith({ backlog: 16 })), Layer.provide(reader))
  return { state, layer }
}

/** Subscribes and watches the chat, as SubscribeChat does, and waits for the first estimate. */
const open = (state: { calls: number }) =>
  Effect.gen(function* () {
    const hub = yield* ChatHub
    const warmth = yield* CacheWarmth
    yield* hub.subscribe(chatId, () => ({ _tag: "Hello", live: [] }))
    yield* warmth.watch(user, chatId)
    yield* eventually(() => state.calls === 1)
    return { hub, warmth }
  })

const change = (hub: ChatHub["Service"]) =>
  hub.publish(chatId, { _tag: "Queue", queue: [] } as unknown as Parameters<ChatHub["Service"]["publish"]>[1])

it.live("a read takes the pushed estimate until a chat event or a refresh changes it", () => {
  const { state, layer } = fixture()
  return Effect.gen(function* () {
    const { hub, warmth } = yield* open(state)
    // The active path, and its leaf in its fork, are what was pushed: no second assembly.
    const pushed = yield* warmth.next(user, chatId, null, null)
    assert.strictEqual(yield* warmth.next(user, chatId, "leaf-1" as SlotId, fork), pushed)
    assert.strictEqual(state.calls, 1)
    // Another leaf or fork is worked out for itself.
    yield* warmth.next(user, chatId, "leaf-0" as SlotId, fork)
    assert.strictEqual(state.calls, 2)
    // A chat event (an edit, a delete, a branch, a swipe, a summary): the read waits for the
    // estimate it starts, and takes that one.
    change(hub)
    const afterEvent = yield* warmth.next(user, chatId, null, null)
    assert.strictEqual(state.calls, 3)
    assert.notStrictEqual(afterEvent, pushed)
    assert.strictEqual(yield* warmth.next(user, chatId, null, null), afterEvent)
    // A refresh (a lorebook, a preset or a model of the user's changed) does the same.
    yield* warmth.refreshUser(user)
    const afterRefresh = yield* warmth.next(user, chatId, null, null)
    assert.strictEqual(state.calls, 4)
    assert.notStrictEqual(afterRefresh, afterEvent)
    yield* warmth.refreshAll
    yield* warmth.next(user, chatId, null, null)
    assert.strictEqual(state.calls, 5)
    // Another user's read never takes it.
    yield* warmth.next("other" as UserId, chatId, null, null)
    assert.strictEqual(state.calls, 6)
  }).pipe(Effect.scoped, Effect.provide(layer))
})

it.live("a change during an estimate makes the read wait for the next one", () => {
  const { state, layer } = fixture()
  return Effect.gen(function* () {
    const { hub, warmth } = yield* open(state)
    state.slow = 300
    change(hub)
    yield* eventually(() => state.calls === 2)
    // Arrives while the estimate runs: that one is stale before it ends.
    change(hub)
    const read = yield* warmth.next(user, chatId, null, null)
    assert.strictEqual(state.calls, 3)
    assert.strictEqual(read.historyStart?.depth, 3)
  }).pipe(Effect.scoped, Effect.provide(layer))
})

it.live("changes wait while a reply is held, and make one estimate when it ends", () => {
  const { state, layer } = fixture()
  return Effect.gen(function* () {
    const { hub, warmth } = yield* open(state)
    const release = warmth.hold(chatId)
    const second = warmth.hold(chatId)
    for (let i = 0; i < 5; i++) change(hub)
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 1, "no estimate while held")
    release()
    release()
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 1, "still held by the other")
    // A read meanwhile at the pushed leaf takes the one estimate the release makes.
    const read = yield* Effect.forkChild(warmth.next(user, chatId, null, null))
    second()
    const estimate = yield* Fiber.join(read)
    assert.strictEqual(state.calls, 2)
    assert.strictEqual(estimate.historyStart?.depth, 2)
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 2)
  }).pipe(Effect.scoped, Effect.provide(layer))
})

it.live("a posted message holds for the reply it expects, until the reply holds or a while passes", () => {
  const { state, layer } = fixture()
  return Effect.gen(function* () {
    const { hub, warmth } = yield* open(state)
    warmth.expectReply(chatId)
    change(hub)
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 1)
    // The reply starts: its hold takes over, and its end makes the estimate.
    const release = warmth.hold(chatId)
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 1)
    release()
    yield* eventually(() => state.calls === 2)
    // No reply comes: the estimate follows after a while.
    warmth.expectReply(chatId)
    change(hub)
    yield* Effect.sleep("1 second")
    assert.strictEqual(state.calls, 2)
    yield* eventually(() => state.calls === 3, 10_000)
  }).pipe(Effect.scoped, Effect.provide(layer))
})
