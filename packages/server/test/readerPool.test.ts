import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { inject } from "vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Schedule } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { workerThreads, writerProtocol } from "../src/db/Database.ts"
import * as ReaderPool from "../src/db/readerPool.ts"
import { PoolOps } from "./support/poolOps.ts"
import { stalls } from "./support/liveness.ts"

class Readers extends Context.Service<Readers, RpcClient.FromGroup<typeof PoolOps, RpcClientError.RpcClientError>>()(
  "test/Readers"
) {}

const poolWorker = new URL("./support/poolWorker.ts", import.meta.url)
const deadWorker = new URL("./support/deadWorker.ts", import.meta.url)

/**
 * Holds test readers (poolWorker.ts) blocked until the test releases them: a Hold request
 * blocks like a query that never ends, and a held start blocks a thread before it serves.
 * A read that went to a held reader could only finish after the release, so the tests
 * below release only after their reads, and wait on no clock.
 */
const makeGate = () => {
  // [0] is 1 once released, [1] counts Holds started, [2] is the thread holding.
  const cells = new Int32Array(new SharedArrayBuffer(12))
  return {
    cells,
    /** Waits until a reader is blocked in a Hold, and returns its thread id. */
    holding: Effect.promise(async () => {
      while (Atomics.load(cells, 1) === 0) await Atomics.waitAsync(cells, 1, 0).value
      return Atomics.load(cells, 2)
    }),
    release: Effect.sync(() => {
      Atomics.store(cells, 0, 1)
      Atomics.notify(cells, 0)
    })
  }
}
type Gate = ReturnType<typeof makeGate>

/** `script` picks each spawned thread's script, and `heldStart` which threads start held, by spawn count. */
const readers = (
  size: number,
  {
    script = () => poolWorker,
    gate,
    heldStart = () => false
  }: {
    script?: (spawn: number) => URL
    gate?: Gate
    heldStart?: (spawn: number) => boolean
  } = {}
) => {
  let spawns = 0
  return Layer.effect(Readers, RpcClient.make(PoolOps)).pipe(
    Layer.provide(ReaderPool.layer(size)),
    Layer.provide(
      NodeWorker.layer(() => {
        const spawn = spawns++
        return new Worker(script(spawn), { workerData: { gate: gate?.cells, heldStart: heldStart(spawn) } })
      })
    )
  )
}

/** The thread ids serving two concurrent reads: distinct when both readers are up. */
const servingThreads = Effect.flatMap(Readers, ({ Count }) =>
  Effect.all([Count({ n: 200_000 }), Count({ n: 200_000 })], { concurrency: 2 })
).pipe(Effect.map((ids) => new Set(ids)))

/** Waits until both readers are up, and returns their thread ids. */
const bothUp = servingThreads.pipe(
  Effect.repeat({ until: (ids) => ids.size === 2 }),
  stalls("both readers never served at once")
)

/** The threads serving five light reads in a row. */
const lightReads = Effect.flatMap(Readers, ({ Count }) =>
  Effect.forEach(Array.from({ length: 5 }), () => Count({ n: 1 }))
).pipe(
  Effect.map((ids) => new Set(ids)),
  stalls("a light read went to a held reader")
)

describe("reader pool", () => {
  it.live(
    "an interrupted read keeps its reader busy until the reader answers",
    () => {
      const gate = makeGate()
      return Effect.gen(function* () {
        const { Hold } = yield* Readers
        const before = yield* bothUp
        // The caller gives up, but the reader is still running the query.
        const held = yield* Effect.forkChild(Hold())
        const heldThread = yield* gate.holding.pipe(stalls("the reader never started its Hold"))
        yield* Fiber.interrupt(held)
        // Every light read goes to the other reader.
        const served = yield* lightReads
        assert.deepStrictEqual(
          [...served],
          [...before].filter((id) => id !== heldThread)
        )
        // Once the held reader answers, it serves again.
        yield* gate.release
        assert.deepStrictEqual(yield* bothUp, before)
      }).pipe(Effect.ensuring(gate.release), Effect.provide(readers(2, { gate })))
    },
    30_000
  )

  it.live(
    "a crashed reader gets no reads until it is back",
    () => {
      const gate = makeGate()
      return Effect.gen(function* () {
        const { Crash } = yield* Readers
        const before = yield* bothUp
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Crash())))
        // Its replacement starts held, so it can't serve before the release: every light
        // read goes to the reader that's still up.
        const served = yield* lightReads
        assert.strictEqual(served.size, 1)
        assert.isTrue(before.has([...served][0]!))
        yield* gate.release
        // The crashed reader is replaced by a new thread.
        const after = yield* bothUp
        assert.strictEqual([...after].filter((id) => !before.has(id)).length, 1)
      }).pipe(Effect.ensuring(gate.release), Effect.provide(readers(2, { gate, heldStart: (spawn) => spawn >= 2 })))
    },
    30_000
  )

  it.live(
    "startup fails when no reader comes up",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Layer.build(readers(2, { script: () => deadWorker })))
        assert.isTrue(Exit.isFailure(exit))
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "reads fail instead of waiting when every reader is down",
    () => {
      // A crash fails every request in flight on any reader, so the Crash calls failing
      // doesn't mean both readers are down, and a crash still being handled would fail a
      // read sent now. A reader respawns only after its crash is handled, so its second
      // stop (the first failed respawn) means its first is done.
      const stops = new Map<string, number>()
      const crashesHandled = Deferred.makeUnsafe<void>()
      const collector = Logger.make((options) => {
        const reader = /^database reader (\d+) stopped/.exec(String(options.message))?.[1]
        if (reader === undefined) return
        stops.set(reader, (stops.get(reader) ?? 0) + 1)
        if (stops.get("0")! >= 2 && stops.get("1")! >= 2) Deferred.doneUnsafe(crashesHandled, Exit.void)
      })
      return Effect.gen(function* () {
        const { Count, Crash } = yield* Readers
        yield* bothUp
        // Both readers crash, and every respawn dies as it starts.
        yield* Effect.all([Effect.exit(Crash()), Effect.exit(Crash())], { concurrency: 2 })
        yield* Deferred.await(crashesHandled).pipe(stalls("the crashes and failed respawns were never logged"))
        const read = yield* Effect.exit(Count({ n: 1 }).pipe(stalls("a read waited while every reader was down")))
        assert.isTrue(Exit.isFailure(read))
        // The failed respawn's error, not a crash's.
        if (Exit.isFailure(read)) assert.include(Cause.pretty(read.cause), "exited with code: 3")
      }).pipe(
        Effect.provide(readers(2, { script: (spawn) => (spawn < 2 ? poolWorker : deadWorker) })),
        Effect.provide(Logger.layer([collector]))
      )
    },
    30_000
  )

  describe("with bundles", () => {
    // A copy of the run's build (support/bundles.ts), since this test changes it.
    const bundleDir = mkdtempSync(join(tmpdir(), "rp-bundles-"))
    cpSync(inject("bundleDir"), bundleDir, { recursive: true })

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
          const read = yield* Effect.exit(Count({ n: 1 }).pipe(stalls("a read waited for a stale reader")))
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
    "a crash is logged with its cause, then failed restarts as a count, then the recovery",
    () => {
      const logs: Array<string> = []
      const collector = Logger.make((options) => {
        const message = String(options.message)
        const caused = options.cause.reasons.length > 0 ? " (cause)" : ""
        if (message.includes("database writer")) logs.push(message + caused)
      })
      // The first thread runs, the next six die as they start, the eighth runs.
      let spawns = 0
      const script = () => {
        const spawn = spawns++
        return spawn === 0 || spawn >= 7 ? poolWorker : deadWorker
      }
      return Effect.gen(function* () {
        const { Count, Crash } = yield* Readers
        yield* Count({ n: 1 })
        yield* Effect.exit(Crash())
        // Requests fail while the writer is down; this one waits for it to come back.
        yield* Count({ n: 1 }).pipe(Effect.retry(Schedule.spaced(200)), Effect.timeout(25_000))
        assert.deepStrictEqual(logs, [
          "database writer stopped; restarting it every second (cause)",
          "database writer still down after 1 failed restarts",
          "database writer still down after 2 failed restarts",
          "database writer still down after 4 failed restarts",
          "database writer is back after 6 failed restarts"
        ])
      }).pipe(
        Effect.provide(
          Layer.effect(Readers, RpcClient.make(PoolOps)).pipe(
            Layer.provide(writerProtocol(NodeWorker.layer(() => new Worker(script()))))
          )
        ),
        Effect.provide(Logger.layer([collector]))
      )
    },
    40_000
  )
})
