import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { tempDir } from "./support/tempDir.ts"
import { slowIt } from "./support/slow.ts"

const run = (seed: number, steps: number) =>
  Effect.promise(
    () =>
      new Promise<{ comparisons: number }>((resolve, reject) => {
        const worker = new Worker(new URL("./support/settlementDifferentialWorker.ts", import.meta.url), {
          workerData: { file: join(tempDir("settlement-differential"), "synthetic.db"), seed, steps }
        })
        let result: { comparisons: number } | undefined
        worker.once("message", (value) => {
          result = value
        })
        worker.once("error", reject)
        worker.once("exit", (code) =>
          code === 0 && result ? resolve(result) : reject(new Error(`differential worker exited ${code}`))
        )
      })
  ).pipe(Effect.tap((result) => Effect.sync(() => assert.isAbove(result.comparisons, steps))))

it.live("optimized settlement equals the frozen scanning statement", () => run(7, 28))
slowIt.live(
  "random bulk rewrites, shared prefixes, swipes, multi-deletes and independent histories settle identically",
  () => Effect.forEach([1, 19, 127, 401, 991], (seed) => run(seed, 140)),
  600_000
)
