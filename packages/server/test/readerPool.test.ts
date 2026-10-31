import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { inject } from "vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Schedule } from "effect"
import { RpcClient, RpcClientError } from "effect/rpc"
import { workerThreads, writerProtocol } from "../src/db/Database.ts"
import * as ReaderPool from "../src/db/readerPool.ts"
import { PoolOps } from "./support/poolOps.ts"
import { stalls } from "./support/liveness.ts"
import { tempDir } from "./support/tempDir.ts"

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
  // [0] is 1 once released, [1] counts Holds started, [2] is the thread holding, [3] is 1
  // once a CrashOnce has crashed.
  const cells = new Int32Array(new SharedArrayBuffer(16))
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
    heldStart = () => false,
    background,
    first
  }: {
    script?: (spawn: number) => URL
    gate?: Gate
    heldStart?: (spawn: number) => boolean
    background?: { readonly tags: ReadonlySet<string>; readonly max: number }
    first?: ReadonlySet<string>
  } = {}
) => {
  let spawns = 0
  return Layer.effect(Readers, ReaderPool.client(PoolOps)).pipe(
    Layer.provide(
      ReaderPool.layer(size, { retryCrashed: true, ...(background ? { background } : {}), ...(first ? { first } : {}) })
    ),
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

/** Collects which reader each logged stop was, in order. */
const stopLog = () => {
  const stops: Array<string> = []
  const logger = Logger.layer([
    Logger.make((options) => {
      const reader = /^database reader (\d+) stopped/.exec(String(options.message))?.[1]
      if (reader !== undefined) stops.push(reader)
    })
  ])
  return { stops, logger }
}

describe("reader pool", () => {
  it.live(
    "background reads leave a reader free: others behind them go first",
    () => {
      const gate = makeGate()
      return Effect.gen(function* () {
        const { Hold } = yield* Readers
        const before = yield* bothUp
        // Two slow background reads: the first takes a reader, the second waits for it.
        const first = yield* Effect.forkChild(Hold())
        const heldThread = yield* gate.holding.pipe(stalls("the reader never started its Hold"))
        const second = yield* Effect.forkChild(Hold())
        // Reads queued after the second still run, on the reader it may not take.
        const served = yield* lightReads
        assert.deepStrictEqual(
          [...served],
          [...before].filter((id) => id !== heldThread)
        )
        assert.strictEqual(Atomics.load(gate.cells, 1), 1, "the second background read waited")
        yield* gate.release
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        assert.strictEqual(Atomics.load(gate.cells, 1), 2)
      }).pipe(
        Effect.ensuring(gate.release),
        Effect.provide(readers(2, { gate, background: { tags: new Set(["Hold"]), max: 1 } }))
      )
    },
    30_000
  )

  for (const ahead of [false, true])
    it.live(
      ahead ? "a reply's reads go ahead of what was queued before them" : "reads otherwise go in order",
      () => {
        const gate = makeGate()
        return Effect.gen(function* () {
          const { Hold, Count } = yield* Readers
          const done: Array<string> = []
          // The one reader is busy; a browsing read, then a reply's, queue behind it.
          const busy = yield* Effect.forkChild(Hold())
          yield* gate.holding.pipe(stalls("the reader never started its Hold"))
          const browsing = yield* Effect.forkChild(
            Hold().pipe(Effect.tap(() => Effect.sync(() => done.push("browsing"))))
          )
          yield* Effect.sleep("100 millis")
          const reply = yield* Effect.forkChild(
            Count({ n: 1 }).pipe(Effect.tap(() => Effect.sync(() => done.push("reply"))))
          )
          yield* Effect.sleep("100 millis")
          yield* gate.release
          yield* Fiber.join(busy)
          yield* Fiber.join(browsing)
          yield* Fiber.join(reply)
          assert.deepStrictEqual(done, ahead ? ["reply", "browsing"] : ["browsing", "reply"])
        }).pipe(
          Effect.ensuring(gate.release),
          Effect.provide(readers(1, { gate, ...(ahead ? { first: new Set(["Count"]) } : {}) }))
        )
      },
      30_000
    )

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
        const { CrashOnce } = yield* Readers
        const before = yield* bothUp
        // The read is retried on the reader that's up.
        const retriedOn = yield* CrashOnce().pipe(stalls("the crashed read was never retried"))
        assert.isTrue(before.has(retriedOn))
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
    "a crash fails no read: the crashed one is retried, and the other reader's read finishes",
    () => {
      const gate = makeGate()
      return Effect.gen(function* () {
        const { CrashOnce, Hold } = yield* Readers
        const before = yield* bothUp
        const held = yield* Effect.forkChild(Hold())
        yield* gate.holding.pipe(stalls("the reader never started its Hold"))
        // Only the other reader is free, so it takes the read and stops, and the retry can
        // only run on its replacement.
        const retriedOn = yield* CrashOnce().pipe(stalls("the crashed read was never retried"))
        assert.isFalse(before.has(retriedOn))
        yield* gate.release
        yield* Fiber.join(held).pipe(stalls("the held read never finished"))
      }).pipe(Effect.ensuring(gate.release), Effect.provide(readers(2, { gate })))
    },
    30_000
  )

  it.live(
    "a read that stops a reader twice fails with a typed error, and isn't retried again",
    () => {
      const gate = makeGate()
      const { stops, logger } = stopLog()
      return Effect.gen(function* () {
        const { Crash, Hold } = yield* Readers
        yield* bothUp
        const held = yield* Effect.forkChild(Hold())
        yield* gate.holding.pipe(stalls("the reader never started its Hold"))
        // It stops the free reader, then that reader's replacement.
        const crash = yield* Effect.exit(Crash().pipe(stalls("the read was retried without end")))
        assert.isTrue(Exit.isFailure(crash))
        if (Exit.isFailure(crash)) {
          const error = Cause.findErrorOption(crash.cause)
          assert.isTrue(Option.isSome(error) && error.value instanceof RpcClientError.RpcClientError, String(crash))
        }
        assert.strictEqual(stops.length, 2)
        assert.strictEqual(stops[0], stops[1])
        // The read held on the other reader never noticed.
        yield* gate.release
        yield* Fiber.join(held).pipe(stalls("the held read never finished"))
        yield* bothUp
        assert.strictEqual(stops.length, 2)
      }).pipe(Effect.ensuring(gate.release), Effect.provide(readers(2, { gate })), Effect.provide(logger))
    },
    30_000
  )

  it.live(
    "a read its caller gave up on isn't retried when it stops its reader",
    () => {
      const gate = makeGate()
      const { stops, logger } = stopLog()
      return Effect.gen(function* () {
        const { HoldThenCrash } = yield* Readers
        yield* bothUp
        const read = yield* Effect.forkChild(HoldThenCrash())
        yield* gate.holding.pipe(stalls("the reader never started the read"))
        yield* Fiber.interrupt(read)
        yield* gate.release
        // A retry would go straight to the other reader, and stop it before both are up.
        yield* bothUp
        assert.strictEqual(stops.length, 1)
      }).pipe(Effect.ensuring(gate.release), Effect.provide(readers(2, { gate })), Effect.provide(logger))
    },
    30_000
  )

  it.live(
    "an answer to a request the reader isn't running is dropped, and finishes nothing",
    () =>
      Effect.gen(function* () {
        const { StrayExit } = yield* Readers
        const before = yield* bothUp
        // Had the stray Exit finished the read, its real answer would be dropped instead.
        const servedBy = yield* StrayExit().pipe(stalls("the read's own answer was dropped"))
        assert.isTrue(before.has(servedBy))
      }).pipe(Effect.provide(readers(2))),
    30_000
  )

  it.live(
    "a protocol defect from a reader is a crash of that reader: its read is retried",
    () => {
      const gate = makeGate()
      const { stops, logger } = stopLog()
      return Effect.gen(function* () {
        const { DefectOnce } = yield* Readers
        const before = yield* bothUp
        const servedBy = yield* DefectOnce().pipe(stalls("the read was never retried"))
        assert.isTrue(before.has(servedBy))
        assert.strictEqual(stops.length, 1)
      }).pipe(Effect.provide(readers(2, { gate })), Effect.provide(logger))
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
      // The Crash calls fail at the first failed respawn, which can come before the other
      // reader's crash is handled. A reader respawns only after its crash is handled, so its
      // second stop (the first failed respawn) means its first is done.
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
    // A copy of the run's build (support/globalSetup.ts), since this test changes it.
    const bundleDir = tempDir("bundles")
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
            Layer.effect(Readers, ReaderPool.client(PoolOps)).pipe(
              Layer.provide(ReaderPool.layer(1, { retryCrashed: true })),
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
