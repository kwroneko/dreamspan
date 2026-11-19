import { writeFileSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { loadavg } from "node:os"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"

lcmTest(
  "plans the 200-branch, 447962-version chat within 200 ms, also after each reply is appended",
  (server) =>
    Effect.gen(function* () {
      const results: Array<unknown> = []
      for (const branches of [1, 200]) {
        const h = yield* lcmHarness(server, { messages: 0 })
        const shape = yield* Effect.promise(
          () =>
            new Promise<Record<string, number>>((resolve, reject) => {
              const worker = new Worker(new URL("./support/lcmPlanningFixtureWorker.ts", import.meta.url), {
                workerData: { file: join(h.dataDir, "dreamspan.db"), chats: [h.chat.id], branches }
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
        // Send, reply appended, next send: appends keep the reader's summary facts
        // (db/lcmFactStore.ts), so the plan the next send waits for reads only what's new.
        let leaf = position.leafSlotId
        const turns: Array<{ before: number; maintenance: number }> = []
        for (let turn = 0; turn < 5; turn++) {
          const version = (writer: "human" | "model", content: string, status: "complete" | "generating") =>
            new NewVersion({
              speakerEntityId: null,
              writer,
              content,
              status,
              macroMode: "verbatim",
              origin: writer === "human" ? "user_written" : "generated"
            })
          const user = yield* h.writer.AppendMessage({
            userId: h.userId,
            chatId: h.chat.id,
            parentSlotId: leaf,
            branch: false,
            commitDraft: null,
            version: version("human", `Synthetic turn ${turn}: the caravan turns toward the ridge.`, "complete")
          })
          const reply = yield* h.writer.AppendMessage({
            userId: h.userId,
            chatId: h.chat.id,
            parentSlotId: user.slotId,
            branch: false,
            commitDraft: null,
            version: version("model", "", "generating")
          })
          const start = performance.now()
          yield* h.reader.PlanSummaries({ ...position, leafSlotId: user.slotId })
          const before = performance.now() - start
          yield* h.writer.FinishGeneration({
            userId: h.userId,
            versionId: reply.version.id,
            content: `Synthetic reply ${turn}. ` + "The wind carried dust over the ridge. ".repeat(12),
            status: "complete",
            error: null
          })
          leaf = reply.slotId
          const after = performance.now()
          const maintained = yield* h.reader.PlanSummaries({ ...position, leafSlotId: leaf, reason: "reply" })
          turns.push({ before, maintenance: performance.now() - after })
          if (maintained.maintenancePins)
            yield* h.writer.SaveLcmMaintenance({ ...position, leafSlotId: leaf, pins: maintained.maintenancePins })
        }
        const sorted = turns.map((t) => t.before).sort((a, b) => a - b)
        assert.isBelow(sorted[2]!, 200, "after-append planning budget (median)")
        assert.isBelow(sorted.at(-1)!, 300, "after-append planning budget (worst, under load)")
        results.push({ shape, coldMs, load: loadavg(), measurements, turns })
        assert.lengthOf(h.mock.requests(), 0)
      }
      if (process.env.LCM_PLANNING_OUTPUT)
        writeFileSync(process.env.LCM_PLANNING_OUTPUT, JSON.stringify(results, null, 2))
      console.log("LCM_PLANNING_SCALE", JSON.stringify(results))
    }),
  { timeout: 600000 }
)
