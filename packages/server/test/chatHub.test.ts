// The hub's per-subscriber backlog: a subscriber that stops taking can't grow it for
// ever; it starts over with a fresh Hello, and what follows continues from there.
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import type { ChatId, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Effect, Queue } from "effect"
import { ChatHub } from "../src/chat/ChatHub.ts"

const chatId = "chat" as ChatId
const versionId = "v" as VersionId

describe("ChatHub", () => {
  it.live("a subscriber a whole backlog behind gets a fresh Hello instead of the backlog", () =>
    Effect.gen(function* () {
      const hub = yield* ChatHub
      let text = ""
      const queue = yield* hub.subscribe(chatId, () => ({ _tag: "Hello", live: [{ versionId, text }] }))
      // Six batches, one a frame, and nobody taking them: the backlog holds four.
      for (let i = 0; i < 6; i++) {
        const offset = text.length
        text += `t${i} `
        hub.publish(chatId, { _tag: "Delta", versionId, offset, text: `t${i} ` })
        yield* Effect.sleep("40 millis")
      }
      const size = Queue.sizeUnsafe(queue)
      assert.isAtMost(size, 4)
      const backlog = (yield* Queue.takeAll(queue)).flat()
      // It started over: a Hello with the text so far comes before anything after it.
      const restart = backlog.findLastIndex((event) => event._tag === "Hello")
      assert.isAbove(restart, -1)
      const hello = backlog[restart] as Extract<ChatEvent, { _tag: "Hello" }>
      let seen = hello.live[0]!.text
      for (const event of backlog.slice(restart + 1)) {
        assert.strictEqual(event._tag, "Delta")
        if (event._tag === "Delta") {
          assert.strictEqual(event.offset, seen.length, "no gap after the Hello")
          seen += event.text
        }
      }
      assert.strictEqual(seen, text)

      // Taking again, it goes on as usual.
      hub.publish(chatId, { _tag: "Delta", versionId, offset: text.length, text: "more" })
      const next = yield* Queue.take(queue)
      assert.deepStrictEqual(next, [{ _tag: "Delta", versionId, offset: text.length, text: "more" }])
    }).pipe(Effect.scoped, Effect.provide(ChatHub.layerWith({ backlog: 4 })))
  )

  it.live("closing a chat still ends a subscriber whose backlog is full", () =>
    Effect.gen(function* () {
      const hub = yield* ChatHub
      const queue = yield* hub.subscribe(chatId, () => ({ _tag: "Hello", live: [] }))
      for (let i = 0; i < 3; i++) {
        hub.publish(chatId, { _tag: "Reload" })
        yield* Effect.sleep("40 millis")
      }
      hub.close(chatId, { _tag: "Deleted" })
      const rest = (yield* Queue.takeAll(queue)).flat()
      assert.deepStrictEqual(rest.at(-1), { _tag: "Deleted" })
    }).pipe(Effect.scoped, Effect.provide(ChatHub.layerWith({ backlog: 2 })))
  )

  it.live("one chat's grace doesn't end another's", () => {
    // Long after the server started, so its first minute holds nothing.
    let now = Date.now() + 3_600_000
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    return Effect.gen(function* () {
      now += 3_600_000
      const hub = yield* ChatHub
      const other = "other" as ChatId
      yield* Effect.scoped(Effect.asVoid(hub.subscribe(chatId, () => ({ _tag: "Hello", live: [] }))))
      now += 10_000
      // Another chat asked about with no grace at all: chatId's own minute still runs.
      assert.isFalse(hub.held(other, 0))
      assert.isTrue(hub.held(chatId, 60_000))
      now += 60_000
      assert.isFalse(hub.held(chatId, 60_000))
    }).pipe(
      Effect.scoped,
      Effect.provide(ChatHub.layerWith({ backlog: 4 })),
      Effect.ensuring(Effect.sync(() => clock.mockRestore()))
    )
  })
})

