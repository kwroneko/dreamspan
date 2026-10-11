import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import * as ReaderPool from "../src/db/readerPool.ts"
import { PoolOps } from "./support/poolOps.ts"

class Readers extends Context.Service<Readers, RpcClient.FromGroup<typeof PoolOps, RpcClientError.RpcClientError>>()(
  "test/Readers"
) {}

const readers = (size: number) =>
  Layer.effect(Readers, RpcClient.make(PoolOps)).pipe(
    Layer.provide(ReaderPool.layer(size)),
    Layer.provide(NodeWorker.layer(() => new Worker(new URL("./support/poolWorker.ts", import.meta.url))))
  )

/** About two seconds of blocking work in a reader. */
const SLOW = 8_000_000

const lightReadMs = Effect.gen(function* () {
  const { Count } = yield* Readers
  const start = performance.now()
  yield* Count({ n: 1 })
  return performance.now() - start
})

/** The thread ids serving two concurrent reads: distinct when both readers are up. */
const servingThreads = Effect.flatMap(Readers, ({ Count }) =>
  Effect.all([Count({ n: 200_000 }), Count({ n: 200_000 })], { concurrency: 2 })
)

describe("reader pool", () => {
  it.live(
    "an interrupted read keeps its reader busy until the reader answers",
    () =>
      Effect.gen(function* () {
        const { Count } = yield* Readers
        assert.strictEqual(new Set(yield* servingThreads).size, 2)
        // The caller gives up, but the reader is still running the query.
        const slow = yield* Effect.exit(Count({ n: SLOW }).pipe(Effect.timeout(200)))
        assert.isTrue(Exit.isFailure(slow))
        for (let i = 0; i < 5; i++) {
          const ms = yield* lightReadMs
          assert.isBelow(ms, 300, `light read ${i} waited ${ms.toFixed(0)} ms`)
        }
      }).pipe(Effect.provide(readers(2))),
    30_000
  )

  it.live(
    "a crashed reader gets no reads until it is back",
    () =>
      Effect.gen(function* () {
        const { Crash } = yield* Readers
        const before = new Set(yield* servingThreads)
        assert.strictEqual(before.size, 2)
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Crash())))
        for (let i = 0; i < 5; i++) {
          const ms = yield* lightReadMs
          assert.isBelow(ms, 300, `light read ${i} waited ${ms.toFixed(0)} ms`)
        }
        // The crashed reader is replaced by a new thread.
        const after = yield* servingThreads.pipe(
          Effect.map((ids) => new Set(ids)),
          Effect.repeat({ until: (ids) => ids.size === 2 }),
          Effect.timeout(10_000)
        )
        assert.strictEqual([...after].filter((id) => !before.has(id)).length, 1)
      }).pipe(Effect.provide(readers(2))),
    30_000
  )
})
