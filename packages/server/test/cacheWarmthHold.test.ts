// The cache estimate's holds (chat/CacheWarmth.ts): estimates, and reads of the next
// context, wait while a reply is prepared or written in the chat, so they never assemble
// beside it; the changes meanwhile make one estimate when it ends. A read is always worked
// out from what's stored when it runs.
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
  const state = { calls: 0 }
  const reader = Layer.succeed(Reader)({
    CacheWarmth: ({ leafSlotId }: { leafSlotId?: string | null }) =>
      Effect.sync(() => {
        state.calls++
        return {
          warmth: null,
          leafSlotId: leafSlotId ?? "leaf-1",
          forkId: fork,
          historyStart: { slotId: null, depth: state.calls },
          summarizedThrough: null
        }
      }),
    NextContextAccess: () => Effect.void
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

it.live("a read of the next context is worked out each time, from what's stored then", () => {
  const { state, layer } = fixture()
  return Effect.gen(function* () {
    const { warmth } = yield* open(state)
    const first = yield* warmth.next(user, chatId, "leaf-1" as SlotId, fork)
    const second = yield* warmth.next(user, chatId, "leaf-1" as SlotId, fork)
    assert.strictEqual(state.calls, 3)
    assert.notStrictEqual(first.historyStart?.depth, second.historyStart?.depth)
  }).pipe(Effect.scoped, Effect.provide(layer))
})

it.live("changes wait while a reply is held, and make one estimate when it ends; reads wait too", () => {
  const { state, layer } = fixture()
  return Effect.gen(function* () {
    const { hub, warmth } = yield* open(state)
    const release = warmth.hold(chatId)
    const second = warmth.hold(chatId)
    for (let i = 0; i < 5; i++) change(hub)
    const read = yield* Effect.forkChild(warmth.next(user, chatId, null, null))
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 1, "no estimate and no read while held")
    release()
    release()
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 1, "still held by the other")
    second()
    yield* Fiber.join(read)
    // The read, and the one estimate the five changes made.
    yield* eventually(() => state.calls === 3)
    yield* Effect.sleep("600 millis")
    assert.strictEqual(state.calls, 3)
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
    // A read waits no longer than that (an API caller that posts and never asks for the reply).
    warmth.expectReply(chatId)
    const started = Date.now()
    yield* warmth.next(user, chatId, null, null)
    assert.isBelow(Date.now() - started, 4000)
  }).pipe(Effect.scoped, Effect.provide(layer))
})
