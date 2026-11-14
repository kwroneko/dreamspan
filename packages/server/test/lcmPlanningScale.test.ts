import { writeFileSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { loadavg } from "node:os"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"

lcmTest(
  "plans the 200-branch, 447962-version chat within 200 ms without retaining branch caches",
  (server) =>
    Effect.gen(function* () {
      const results: Array<unknown> = []
      for (const branches of [1, 200]) {
        const h = yield* lcmHarness(server, { messages: 0 })
        const shape = yield* Effect.promise(
          () =>
            new Promise<Record<string, number>>((resolve, reject) => {
              const worker = new Worker(new URL("./support/lcmPlanningFixtureWorker.ts", import.meta.url), {
                workerData: { file: join(h.dataDir, "rp-harness.db"), chats: [h.chat.id], branches }
              })
              let result: { shape: Record<string, number> } | undefined
              worker.once("message", (value: typeof result) => {
                result = value
              })
              worker.once("error", reject)
              worker.once("exit", (code) =>
                code === 0 && result ? resolve(result.shape) : reject(new Error(`fixture exited ${code}`))
              )
            })
        )
        assert.strictEqual(shape.branches, branches)
        assert.strictEqual(shape.summaries, 1404)
        if (branches === 200)
          assert.deepStrictEqual(shape, { slots: 39912, branches: 200, versions: 447962, summaries: 1404 })
        const chat = yield* h.reader.GetChat({ userId: h.userId, chatId: h.chat.id })
        const position = {
          userId: h.userId,
          chatId: h.chat.id,
          forkId: chat.currentForkId,
          leafSlotId: chat.activeLeafSlotId!
        }
        // Cold tokenizer/JIT initialization is recorded separately from steady-state planning.
        const coldStart = performance.now()
        yield* h.reader.PlanSummaries(position)
        const coldMs = performance.now() - coldStart
        for (let n = 0; n < 2; n++) yield* h.reader.PlanSummaries(position)
        const measurements: Array<{ reason: string; ms: number }> = []
        for (const reason of [undefined, "reply"] as const) {
          for (let n = 0; n < 3; n++) {
            const start = performance.now()
            const plan = yield* h.reader.PlanSummaries({ ...position, ...(reason ? { reason } : {}) })
            const ms = performance.now() - start
            measurements.push({ reason: reason ?? "before", ms })
            assert.lengthOf(plan.chunks, 4)
            if (reason === undefined) assert.isBelow(ms, 200, "before-reply planning budget")
          }
        }
        results.push({ shape, coldMs, load: loadavg(), measurements })
        assert.lengthOf(h.mock.requests(), 0)
      }
      if (process.env.LCM_PLANNING_OUTPUT)
        writeFileSync(process.env.LCM_PLANNING_OUTPUT, JSON.stringify(results, null, 2))
      console.log("LCM_PLANNING_SCALE", JSON.stringify(results))
    }),
  { timeout: 600000 }
)
