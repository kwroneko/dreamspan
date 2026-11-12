import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeSourceCache } from "../src/sources/cache.ts"
import { withConditionalGets } from "../src/sources/httpCache.ts"
import { makeSourceHttp } from "../src/sources/guard.ts"
import { makeLimiter } from "../src/sources/limiter.ts"
import { fakeCardexAdapter, startFakeArchive } from "./support/fakeArchive.ts"
import { emptySourceQuery } from "@rp/shared/cardSources.ts"

it.effect(
  "expired pages, opened cards and pictures validate without transferring unchanged bodies, per user and across restart",
  () =>
    Effect.gen(function* () {
      const dataDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "rp-source-validators-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(dataDir, { recursive: true, force: true })))
      const fake = yield* Effect.promise(() => startFakeArchive({ cards: 120 }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fake.close()))
      const adapter = fakeCardexAdapter(fake)
      const http = makeSourceHttp(adapter, null, {
        network: { fetchFor: () => fetch },
        limiter: makeLimiter(),
        bypassEntries: () => []
      })
      let now = 0
      const cache = makeSourceCache({ dataDir, now: () => now })
      yield* cache.scan
      const alice = withConditionalGets(http, cache, "alice", adapter.id)
      const first = yield* adapter.search(alice, emptySourceQuery, null)
      const card = yield* adapter.card(alice, first.items[0]!.remoteId)
      const image = yield* adapter.image(alice, first.items[0]!.image!)
      assert.strictEqual(fake.conditionalHits(), 0)
      now += 8 * 86_400_000
      yield* cache.sweep
      const again = yield* adapter.search(alice, emptySourceQuery, null)
      const cardAgain = yield* adapter.card(alice, first.items[0]!.remoteId)
      const imageAgain = yield* adapter.image(alice, first.items[0]!.image!)
      assert.deepStrictEqual(again, first)
      assert.deepStrictEqual(cardAgain, card)
      assert.deepStrictEqual(imageAgain, image)
      assert.strictEqual(fake.conditionalHits(), 6)
      assert.strictEqual(fake.notModified(), 6)
      const restarted = makeSourceCache({ dataDir, now: () => now })
      yield* restarted.scan
      yield* adapter.card(withConditionalGets(http, restarted, "alice", adapter.id), first.items[0]!.remoteId)
      assert.strictEqual(fake.notModified(), 9)
      const before = fake.conditionalHits()
      yield* adapter.card(withConditionalGets(http, restarted, "bob", adapter.id), first.items[0]!.remoteId)
      assert.strictEqual(fake.conditionalHits(), before)
      fake.publish(first.items[0]!.remoteId)
      const changed = yield* adapter.card(
        withConditionalGets(http, restarted, "alice", adapter.id),
        first.items[0]!.remoteId
      )
      assert.notStrictEqual(changed.summary.version.id, card.summary.version.id)
      yield* restarted.clearUser("alice", adapter.id)
      const cleared = fake.conditionalHits()
      yield* adapter.card(withConditionalGets(http, restarted, "alice", adapter.id), first.items[0]!.remoteId)
      assert.strictEqual(fake.conditionalHits(), cleared)
    }).pipe(Effect.scoped)
)
