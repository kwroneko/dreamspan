import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { tempDir } from "./support/tempDir.ts"

it.live("overridden shell paths reuse their covered slot instead of looking it up again per message", () =>
  Effect.gen(function* () {
    const file = join(tempDir("shell-selection"), "probe.db")
    const { visits, labels, rows } = yield* Effect.promise(
      () =>
        new Promise<{
          visits: number
          labels: number
          rows: Array<{ fork_id: string; id: string; version_seq: number; deleted_at: number | null; at: number }>
        }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/shellSelectionWorker.ts", import.meta.url), {
            workerData: { file }
          })
          worker.once("message", resolve)
          worker.once("error", reject)
        })
    )
    assert.lengthOf(rows, 2000)
    for (const fork of ["current", "frozen"]) {
      const own = rows.filter((row) => row.fork_id === fork)
      assert.lengthOf(own, 1000)
      for (let i = 0; i < own.length; i++) {
        const changed = fork === "current" && i === 700
        assert.strictEqual(own[i]!.id, `s${i}`)
        assert.strictEqual(own[i]!.version_seq, i * 100 + (changed ? 5 : 0))
        assert.strictEqual(own[i]!.at, changed ? i : 1000 + i)
        assert.strictEqual(own[i]!.deleted_at, fork === "current" && i === 123 ? 1 : null)
      }
    }
    assert.isAtLeast(visits, rows.length, "count actual covered slot visits")
    assert.isBelow(visits, rows.length + 30, "only chain heads need extra slot lookups")
    assert.isBelow(labels, 10, "a fork point is read once per view, not for every override probe")
  })
)
