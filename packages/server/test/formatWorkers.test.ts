// The format workers (ARCHITECTURE.md §10.3): parsing happens off the main thread, and a
// worker that dies fails only the file it had.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { buildWorkers } from "../scripts/build-workers.ts"
import * as Formats from "../src/importer/Formats.ts"
import * as Importers from "../src/importer/importers.ts"
import { cardChunk, json, png, stCardV2 } from "./formats/support.ts"

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
    60_000
  )

  it.live(
    "a worker that dies fails only the file it had; the files queued behind it parse on its replacement",
    () =>
      Effect.gen(function* () {
        const formats = yield* Formats.Formats
        // With one worker, the second file waits in the queue while the first kills it.
        const [crashed, queued] = yield* Effect.all(
          [Effect.exit(formats.parse(card(), "crash")), Effect.exit(formats.parse(card(), "wren.png"))],
          { concurrency: 2 }
        )
        assert.isTrue(Exit.isFailure(crashed) && crashed.cause.toString().includes("FormatWorkerFailed"))
        assert.isTrue(Exit.isSuccess(queued) && queued.value.report.format === "card-v2-png", String(queued))
        const next = yield* formats.parse(card(), "wren.png")
        assert.strictEqual(next.report.format, "card-v2-png")
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

  describe("bundled", () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "rp-bundles-"))
    beforeAll(() => buildWorkers(bundleDir), 120_000)

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
