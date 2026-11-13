import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { tempDir } from "./support/tempDir.ts"

it.live("seeking a newer window across branches probes segments, independent of distance from the leaf", () =>
  Effect.gen(function* () {
    const dir = tempDir("ancestor-probes")
    const [small, large] = yield* Effect.promise(
      () =>
        new Promise<Array<{ length: number; visits: number; last: string }>>((resolve, reject) => {
          const worker = new Worker(new URL("./support/ancestorProbeWorker.ts", import.meta.url), {
            workerData: { dir }
          })
          let result: Array<{ length: number; visits: number; last: string }> | undefined
          worker.once("message", (value) => {
            result = value
          })
          worker.once("error", reject)
          worker.once("exit", (code) =>
            code === 0 && result ? resolve(result) : reject(new Error(`ancestor probe worker exited ${code}`))
          )
        })
    )
    assert.strictEqual(small!.last, "p-60")
    assert.strictEqual(large!.last, "p-60")
    assert.isAbove(small!.visits, 0)
    assert.isBelow(small!.visits, 300)
    assert.isAtMost(large!.visits, small!.visits + 10, "adding 9,000 messages must not add ancestor probes")
  })
)
