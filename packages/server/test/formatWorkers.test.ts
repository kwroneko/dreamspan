// The format workers (ARCHITECTURE.md §11.3): parsing happens off the main thread, and a
// worker that dies fails only the file it had.
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Logger } from "effect"
import * as Formats from "../src/importer/Formats.ts"
import * as Importers from "../src/importer/importers.ts"
import { inject } from "vitest"
import { cardChunk, json, png, stCardV2 } from "./formats/support.ts"
import { stalls } from "./support/liveness.ts"

/** Largest gap between 5 ms timer ticks on this thread while `effect` runs. */
const mainThreadLag = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    let last = performance.now()
    let maxLag = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - last - 5)
      last = now
    }, 5)
    const result = yield* effect.pipe(Effect.ensuring(Effect.sleep(30)))
    clearInterval(timer)
    return { result, maxLagMs: maxLag }
  })

/** A World Info file of 10,000 entries with 1 KB of content each, about 11 MB. */
const bigLorebook = () => {
  const content = "The harbor freezes in winter. ".repeat(34)
  const entries = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, uid) => [uid, { uid, key: [`key${uid}`], content, comment: `entry ${uid}` }])
  )
  return json({ name: "Big", entries })
}

const card = () => png(cardChunk("chara", stCardV2()))

describe("format workers", () => {
  it.live(
    "parse off the main thread",
    () =>
      Effect.gen(function* () {
        const formats = yield* Formats.Formats
        yield* formats.parse(card(), "warm-up.png")
        const bytes = bigLorebook()
        const offMain = yield* mainThreadLag(formats.parse(bytes, "big.json"))
        // Measured after, so the garbage it leaves isn't collected during the measurement above.
        const onMain = yield* mainThreadLag(
          Importers.parseFile(bigLorebook(), "big.json").pipe(Effect.provide(Importers.layer))
        )
        assert.strictEqual(offMain.result.library?.kind, "lorebook")
        // The upload's buffer went to the worker instead of being copied.
        assert.strictEqual(bytes.byteLength, 0)
        const lags = `${offMain.maxLagMs.toFixed(0)} ms with workers, ${onMain.maxLagMs.toFixed(0)} ms without`
        // Loose bounds: the host is shared, and its load shows in any timer.
        assert.isAbove(onMain.maxLagMs, 200, `the baseline should block: ${lags}`)
        assert.isBelow(offMain.maxLagMs, Math.min(250, onMain.maxLagMs / 4), `main thread lag: ${lags}`)
      }).pipe(Effect.provide(Formats.layer({ workers: "source", size: 1 }))),
    { timeout: 60_000, tags: ["slow"] }
  )

  it.live(
    "a worker that dies fails only the file it had, without retrying it; the files queued behind it parse on its replacement",
    () => {
      let stops = 0
      const collector = Logger.make((options) => {
        if (/^format worker \d+ stopped/.test(String(options.message))) stops++
      })
      return Effect.gen(function* () {
        const formats = yield* Formats.Formats
        // With one worker, the second file waits in the queue while the first kills it.
        const [crashed, queued] = yield* Effect.all(
          [Effect.exit(formats.parse(card(), "crash")), Effect.exit(formats.parse(card(), "wren.png"))],
          { concurrency: 2 }
        )
        assert.isTrue(Exit.isFailure(crashed) && crashed.cause.toString().includes("FormatWorkerFailed"))
        // A crash says nothing about the file: files the parsers can't read are reports.
        if (Exit.isFailure(crashed)) {
          assert.strictEqual(
            String(Cause.squash(crashed.cause)),
            "FormatWorkerFailed: The import failed on the server; try again."
          )
        }
        assert.isTrue(Exit.isSuccess(queued) && queued.value.report.format === "card-v2-png", String(queued))
        const next = yield* formats.parse(card(), "wren.png")
        assert.strictEqual(next.report.format, "card-v2-png")
        // A retry would have run first in line, on the replacement, and stopped it too.
        assert.strictEqual(stops, 1)
      }).pipe(
        Effect.provide(
          Formats.layer({
            workers: "source",
            size: 1,
            entry: new URL("./support/crashingFormatWorker.ts", import.meta.url)
          })
        ),
        Effect.provide(Logger.layer([collector]))
      )
    },
    60_000
  )

  it.live(
    "a file that can't be sent fails alone, even first in line on a new worker",
    () =>
      Effect.gen(function* () {
        const formats = yield* Formats.Formats
        // Its buffer is detached, so sending it throws. Behind a crash, it goes to the
        // replacement before that is ready to take messages, and Effect's worker holds it.
        const unsendable = new Uint8Array(8)
        structuredClone(unsendable.buffer, { transfer: [unsendable.buffer] })
        const [, failed] = yield* Effect.all(
          [Effect.exit(formats.parse(card(), "crash")), Effect.exit(formats.parse(unsendable, "detached.png"))],
          { concurrency: 2 }
        )
        assert.isTrue(Exit.isFailure(failed))
        for (const name of ["a.png", "b.png"]) {
          const parsed = yield* formats.parse(card(), name).pipe(stalls("a file after it never parsed"))
          assert.strictEqual(parsed.report.format, "card-v2-png")
        }
      }).pipe(
        Effect.provide(
          Formats.layer({
            workers: "source",
            size: 1,
            entry: new URL("./support/crashingFormatWorker.ts", import.meta.url)
          })
        )
      ),
    60_000
  )

  it.live(
    "a parse that never returns is failed at its deadline, its worker stopped; the files behind it parse",
    () =>
      Effect.gen(function* () {
        const formats = yield* Formats.Formats
        const start = Date.now()
        const [looping, queued] = yield* Effect.all(
          [Effect.exit(formats.parse(card(), "loop")), Effect.exit(formats.parse(card(), "wren.png"))],
          { concurrency: 2 }
        )
        assert.isTrue(Exit.isFailure(looping) && looping.cause.toString().includes("FormatWorkerFailed"))
        assert.isBelow(Date.now() - start, 15_000)
        assert.isTrue(Exit.isSuccess(queued) && queued.value.report.format === "card-v2-png", String(queued))
      }).pipe(
        Effect.provide(
          Formats.layer({
            workers: "source",
            size: 1,
            jobDeadlineMs: 2_000,
            entry: new URL("./support/crashingFormatWorker.ts", import.meta.url)
          })
        )
      ),
    { timeout: 60_000, tags: ["slow"] }
  )

  describe("bundled", () => {
    // Built once per run by the global setup.
    const bundleDir = inject("bundleDir")

    it.live(
      "parse the same way",
      () =>
        Effect.gen(function* () {
          const parsed = yield* (yield* Formats.Formats).parse(card(), "wren.png")
          assert.strictEqual(parsed.report.format, "card-v2-png")
          assert.lengthOf(parsed.media, 1)
        }).pipe(Effect.provide(Formats.layer({ workers: "bundle", size: 1, bundleDir }))),
      60_000
    )
  })
})
