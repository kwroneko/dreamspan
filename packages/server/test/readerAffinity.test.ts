import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer } from "effect"
import { type RpcClient, type RpcClientError, type RpcMessage } from "effect/rpc"
import * as ReaderPool from "../src/db/readerPool.ts"
import { PoolOps } from "./support/poolOps.ts"
import { stalls } from "./support/liveness.ts"

class Readers extends Context.Service<Readers, RpcClient.FromGroup<typeof PoolOps, RpcClientError.RpcClientError>>()(
  "test/AffinityReaders"
) {}

const harness = (holdHasAffinity = false) => {
  const cells = new Int32Array(new SharedArrayBuffer(16))
  const affinity = (r: RpcMessage.RequestEncoded) =>
    (r.tag === "Count" && (r.payload as { n: number }).n === 1) ||
    (holdHasAffinity && (r.tag === "Hold" || r.tag === "CrashOnce"))
      ? "chat"
      : undefined
  const layer = Layer.effect(Readers, ReaderPool.client(PoolOps)).pipe(
    Layer.provide(ReaderPool.layer(2, { affinity, retryCrashed: true })),
    Layer.provide(
      NodeWorker.layer(
        () => new Worker(new URL("./support/poolWorker.ts", import.meta.url), { workerData: { gate: cells } })
      )
    )
  )
  const holding = Effect.promise(async () => {
    while (Atomics.load(cells, 1) === 0) await Atomics.waitAsync(cells, 1, 0).value
    return Atomics.load(cells, 2)
  })
  const release = Effect.sync(() => {
    Atomics.store(cells, 0, 1)
    Atomics.notify(cells, 0)
  })
  return { layer, holding, release }
}
const bothUp = Effect.flatMap(Readers, ({ Count }) =>
  Effect.all([Count({ n: 200_000 }), Count({ n: 200_000 })], { concurrency: 2 })
).pipe(Effect.repeat({ until: (ids) => new Set(ids).size === 2 }), stalls("both readers never became ready"))

it.live("planning prefers its last reader when idle", () => {
  const h = harness()
  return Effect.gen(function* () {
    const { Hold, Count } = yield* Readers
    yield* bothUp
    const held = yield* Effect.forkChild(Hold())
    const holding = yield* h.holding
    const planned = yield* Count({ n: 1 })
    assert.notStrictEqual(planned, holding)
    yield* h.release
    yield* Fiber.join(held)
    assert.strictEqual(yield* Count({ n: 1 }), planned, "an idle first reader must not steal the warm plan")
    assert.strictEqual(yield* Count({ n: 2 }), holding, "other reads retain ordinary scheduling")
  }).pipe(Effect.ensuring(h.release), Effect.provide(h.layer), Effect.scoped)
})

it.live("a busy preferred reader does not hold up another read", () => {
  const h = harness(true)
  return Effect.gen(function* () {
    const { Hold, Count } = yield* Readers
    yield* bothUp
    const planned = yield* Count({ n: 1 })
    const held = yield* Effect.forkChild(Hold())
    assert.strictEqual(yield* h.holding, planned)
    assert.notStrictEqual(yield* Count({ n: 1 }).pipe(stalls("affinity waited on a busy reader")), planned)
    yield* h.release
    yield* Fiber.join(held)
  }).pipe(Effect.ensuring(h.release), Effect.provide(h.layer), Effect.scoped)
})

it.live("a crashed preferred reader loses its hint and the retry warms the surviving reader", () => {
  const h = harness(true)
  return Effect.gen(function* () {
    const { Count, CrashOnce } = yield* Readers
    yield* bothUp
    const before = yield* Count({ n: 1 })
    const retried = yield* CrashOnce()
    assert.notStrictEqual(retried, before)
    assert.strictEqual(yield* Count({ n: 1 }), retried)
  }).pipe(Effect.ensuring(h.release), Effect.provide(h.layer), Effect.scoped)
})
