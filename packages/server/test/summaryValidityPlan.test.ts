import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"

it("settles touched versions by identity without scanning the chat's other swipes", async () => {
  const worker = new Worker(new URL("./support/summaryValidityPlanWorker.ts", import.meta.url))
  const plans = await new Promise<Array<Array<{ detail: string }>>>((resolve, reject) => {
    let plans: Array<Array<{ detail: string }>> | undefined
    worker.once("message", (rows: typeof plans) => (plans = rows))
    worker.once("error", reject)
    worker.once("exit", (code) =>
      code === 0 && plans ? resolve(plans) : reject(new Error(`settlement plan worker exited ${code}`))
    )
  })
  assert.lengthOf(plans, 2)
  for (const plan of plans) {
    const versions = plan.filter((row) => /^(?:SCAN|SEARCH) v\b/.test(row.detail))
    assert.isNotEmpty(versions)
    assert.isTrue(
      versions.every((row) => /^SEARCH v\b.*\(id=\?\)/.test(row.detail)),
      JSON.stringify(versions)
    )
  }
})
