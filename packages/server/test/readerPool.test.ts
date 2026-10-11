import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { assert, beforeAll, describe, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Layer, Logger } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { workerThreads, writerProtocol } from "../src/db/Database.ts"
import * as ReaderPool from "../src/db/readerPool.ts"
import { buildWorkers } from "../scripts/build-workers.ts"
import { PoolOps } from "./support/poolOps.ts"

class Readers extends Context.Service<Readers, RpcClient.FromGroup<typeof PoolOps, RpcClientError.RpcClientError>>()(
  "test/Readers"
) {}

const poolWorker = new URL("./support/poolWorker.ts", import.meta.url)
const deadWorker = new URL("./support/deadWorker.ts", import.meta.url)

/** `script` picks each spawned thread's script, by spawn count. */
const readers = (size: number, script: (spawn: number) => URL = () => poolWorker) => {
  let spawns = 0
  return Layer.effect(Readers, RpcClient.make(PoolOps)).pipe(
    Layer.provide(ReaderPool.layer(size)),
    Layer.provide(NodeWorker.layer(() => new Worker(script(spawns++))))
  )
}

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
).pipe(Effect.map((ids) => new Set(ids)))

/** Waits until both readers are up, and returns their thread ids. */
const bothUp = servingThreads.pipe(Effect.repeat({ until: (ids) => ids.size === 2 }), Effect.timeout(10_000))

describe("reader pool", () => {
  it.live(
    "an interrupted read keeps its reader busy until the reader answers",
    () =>
      Effect.gen(function* () {
        const { Count } = yield* Readers
        yield* bothUp
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
        const before = yield* bothUp
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Crash())))
        for (let i = 0; i < 5; i++) {
          const ms = yield* lightReadMs
          assert.isBelow(ms, 300, `light read ${i} waited ${ms.toFixed(0)} ms`)
        }
        // The crashed reader is replaced by a new thread.
        const after = yield* bothUp
        assert.strictEqual([...after].filter((id) => !before.has(id)).length, 1)
      }).pipe(Effect.provide(readers(2))),
    30_000
  )

  it.live(
    "startup fails when no reader comes up",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Layer.build(readers(2, () => deadWorker)))
        assert.isTrue(Exit.isFailure(exit))
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "reads fail instead of waiting when every reader is down",
    () =>
      Effect.gen(function* () {
        const { Count, Crash } = yield* Readers
        yield* bothUp
        // Both readers crash, and every respawn dies as it starts.
        yield* Effect.exit(Effect.all([Crash(), Crash()], { concurrency: 2 }))
        yield* Effect.sleep(300)
        const read = yield* Effect.exit(Count({ n: 1 }).pipe(Effect.timeout(5000)))
        assert.isTrue(Exit.isFailure(read))
        // The failed respawn's error, not a timeout.
        if (Exit.isFailure(read)) assert.include(Cause.pretty(read.cause), "exited with code: 3")
      }).pipe(Effect.provide(readers(2, (spawn) => (spawn < 2 ? poolWorker : deadWorker)))),
    30_000
  )

  describe("with bundles", () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "rp-bundles-"))
    beforeAll(() => buildWorkers(bundleDir), 60_000)

    it.live(
      "a crashed reader isn't replaced by code from a newer build",
      () =>
        Effect.gen(function* () {
          const { Count, Crash } = yield* Readers
          yield* Count({ n: 1 })
          // As if `npm run build` ran against the live checkout.
          const stampFile = join(bundleDir, "stamp.json")
          writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(readFileSync(stampFile, "utf8")), hash: "0" }))
          yield* Effect.exit(Crash())
          yield* Effect.sleep(300)
          const read = yield* Effect.exit(Count({ n: 1 }).pipe(Effect.timeout(5000)))
          assert.isTrue(Exit.isFailure(read))
          if (Exit.isFailure(read)) assert.include(Cause.pretty(read.cause), "npm run build")
        }).pipe(
          Effect.provide(
            Layer.effect(Readers, RpcClient.make(PoolOps)).pipe(
              Layer.provide(ReaderPool.layer(1)),
              Layer.provide(workerThreads(poolWorker, {}, bundleDir))
            )
          )
        ),
      30_000
    )
  })
})

describe("writer worker", () => {
  it.live(
    "a crash and every failed respawn are logged",
    () => {
      const stops: Array<string> = []
      const collector = Logger.make((options) => {
        const message = String(options.message)
        if (message.includes("database writer stopped")) stops.push(message)
      })
      let spawns = 0
      return Effect.gen(function* () {
        const { Count, Crash } = yield* Readers
        yield* Count({ n: 1 })
        assert.deepStrictEqual(stops, [])
        // The writer crashes, and every respawn dies as it starts.
        yield* Effect.exit(Crash())
        yield* Effect.sleep(2500)
        // The crash, then at least one failed respawn.
        assert.isAtLeast(stops.length, 2, stops.join("\n"))
      }).pipe(
        Effect.provide(
          Layer.effect(Readers, RpcClient.make(PoolOps)).pipe(
            Layer.provide(writerProtocol(NodeWorker.layer(() => new Worker(spawns++ === 0 ? poolWorker : deadWorker))))
          )
        ),
        Effect.provide(Logger.layer([collector]))
      )
    },
    30_000
  )
})
