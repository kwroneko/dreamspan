import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Semaphore } from "effect"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { storeStaleParts } from "../src/db/Database.ts"
import { makeShellMaterialization } from "../src/db/shellMaterialization.ts"

const owner = "synthetic-owner" as UserId

it.effect("completed account snapshots have a bounded retention window", () =>
  Effect.gen(function* () {
    let calls = 0
    const shared = yield* makeShellMaterialization(() => Effect.sync(() => ++calls))
    const users = Array.from({ length: 17 }, (_, n) => `synthetic-${n}` as UserId)
    for (const user of users) yield* shared.get(user, "same-epoch")
    assert.strictEqual(yield* shared.get(users.at(-1)!, "same-epoch"), 17)
    assert.strictEqual(calls, 17, "recent accounts still share their snapshot")
    assert.strictEqual(yield* shared.get(users[0]!, "same-epoch"), 18, "old completed accounts release their data")
  }).pipe(Effect.scoped)
)

it.effect("overlapping shell views and a replacement navigation share work after all original waiters leave", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let calls = 0
    const shared = yield* makeShellMaterialization(() =>
      Effect.gen(function* () {
        calls++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return calls
      })
    )
    const first = yield* Effect.forkChild(shared.get(owner))
    yield* Deferred.await(started)
    yield* Fiber.interrupt(first)
    const cards = yield* Effect.forkChild(shared.get(owner))
    const forks = yield* Effect.forkChild(shared.get(owner))
    yield* Deferred.succeed(release, undefined)
    assert.strictEqual(yield* Fiber.join(cards), 1)
    assert.strictEqual(yield* Fiber.join(forks), 1)
    assert.strictEqual(yield* shared.get(owner), 1)
    assert.strictEqual(calls, 1)
  }).pipe(Effect.scoped)
)

it.effect("a new invalidation epoch drains the old read, and its result cannot replace the new one", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const firstRelease = yield* Deferred.make<void>()
    const secondRelease = yield* Deferred.make<void>()
    let calls = 0
    const shared = yield* makeShellMaterialization(() =>
      Effect.gen(function* () {
        const call = ++calls
        yield* Deferred.succeed(call === 1 ? firstStarted : secondStarted, undefined)
        yield* Deferred.await(call === 1 ? firstRelease : secondRelease)
        return call
      })
    )
    const old = yield* Effect.forkChild(shared.get(owner))
    yield* Deferred.await(firstStarted)
    yield* shared.invalidate
    const current = yield* Effect.forkChild(shared.get(owner))
    assert.strictEqual(calls, 1, "same-user materializations never overlap, including across epochs")
    yield* Deferred.succeed(firstRelease, undefined)
    yield* Deferred.await(secondStarted)
    assert.strictEqual(yield* Fiber.join(old), 1)
    const next = yield* Effect.forkChild(shared.get(owner))
    yield* Deferred.succeed(secondRelease, undefined)
    assert.strictEqual(yield* Fiber.join(current), 2)
    assert.strictEqual(yield* Fiber.join(next), 2)
    assert.strictEqual(yield* shared.get(owner), 2)
    assert.strictEqual(calls, 2)
  }).pipe(Effect.scoped)
)

it.effect("failures are retried and accounts never share a snapshot", () =>
  Effect.gen(function* () {
    let calls = 0
    const shared = yield* makeShellMaterialization((userId) =>
      Effect.suspend(() => {
        calls++
        return calls === 1 ? Effect.fail("read failed") : Effect.succeed(userId)
      })
    )
    assert.isTrue(Exit.isFailure(yield* Effect.exit(shared.get(owner))))
    assert.strictEqual(yield* shared.get(owner), owner)
    const other = "synthetic-other" as UserId
    assert.strictEqual(yield* shared.get(other), other)
    assert.strictEqual(calls, 3)
  }).pipe(Effect.scoped)
)

it.effect("epochs arriving during a read share one latest queued computation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let state = 1
    let calls = 0
    const shared = yield* makeShellMaterialization(() =>
      Effect.gen(function* () {
        const value = state
        if (++calls === 1) {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }
        return value
      })
    )
    const first = yield* Effect.forkChild(shared.get(owner, "one"))
    yield* Deferred.await(started)
    state = 2
    const second = yield* Effect.forkChild(shared.get(owner, "two"))
    yield* Effect.yieldNow
    state = 3
    const third = yield* Effect.forkChild(shared.get(owner, "three"))
    yield* Effect.yieldNow
    state = 4
    const fourth = yield* Effect.forkChild(shared.get(owner, "four"))
    yield* Effect.yieldNow
    assert.strictEqual(calls, 1, "a superseded read must drain before the next one starts")
    yield* Deferred.succeed(release, undefined)
    assert.strictEqual(yield* Fiber.join(first), 1)
    assert.strictEqual(yield* Fiber.join(second), 4)
    assert.strictEqual(yield* Fiber.join(third), 4)
    assert.strictEqual(yield* Fiber.join(fourth), 4)
    assert.strictEqual(yield* shared.get(owner, "four"), 4)
    assert.strictEqual(calls, 2, "intermediate epochs never become separate full-tree jobs")
  }).pipe(Effect.scoped)
)

// What a write costs a part is computed again by the next; only parts that keep losing what
// they computed hand the rest to the materialization (db/Database.ts).
it.effect("stored parts continue past one part a write cost, and stop after two in a row", () =>
  Effect.gen(function* () {
    const run = (remaining: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        let parts = 0
        let stored = 0
        yield* storeStaleParts(
          Semaphore.makeUnsafe(1),
          () => Effect.sync(() => ({ chats: ["synthetic-chat"], remaining: remaining[parts++]! })),
          () => Effect.sync(() => void stored++)
        )
        return { parts, stored }
      })
    assert.deepStrictEqual(yield* run([184, 184, 152, 104, 0]), { parts: 5, stored: 5 })
    assert.deepStrictEqual(yield* run([184, 190, 170, 100, 120, 90, 0]), { parts: 7, stored: 7 })
    assert.deepStrictEqual(yield* run([184, 184, 184, 0]), { parts: 3, stored: 3 })
    // Measured against the fewest left so far, so counts a write keeps pushing back still stop.
    assert.deepStrictEqual(yield* run([184, 190, 184, 190, 0]), { parts: 3, stored: 3 })
  })
)
