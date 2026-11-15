import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"

it("an inserted LCM path seeks overrides instead of scanning the selection table for each position", async () => {
  const worker = new Worker(new URL("./support/lcmPathPlanWorker.ts", import.meta.url))
  const result = await new Promise<{
    rows: Array<{ id: string; versionId: string | null; content: string; position: number }>
    plans: Array<Array<{ detail: string }>>
  }>((resolve, reject) => {
    let result: Parameters<typeof resolve>[0] | undefined
    worker.once("message", (value: typeof result) => (result = value))
    worker.once("error", reject)
    worker.once("exit", (code) =>
      code === 0 && result ? resolve(result) : reject(new Error(`LCM path plan worker exited ${code}`))
    )
  })
  assert.deepStrictEqual(
    result.rows.map(({ id, versionId, content, position }) => ({ id, versionId, content, position })),
    [
      { id: "s0", versionId: "v1", content: "Chosen.", position: 0 },
      { id: "si", versionId: "vi", content: "Inserted.", position: 1 }
    ]
  )
  assert.isNotEmpty(result.plans)
  for (const plan of result.plans) {
    assert.isFalse(
      plan.some((row) => /^SCAN so\b/.test(row.detail)),
      JSON.stringify(plan)
    )
    assert.isTrue(
      plan.some((row) => /^SEARCH fx_s\b/.test(row.detail)),
      JSON.stringify(plan)
    )
  }
})
