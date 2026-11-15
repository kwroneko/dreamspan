import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"

it("GetStateMarks keeps indexed event and override probes on the complete stacked schema", async () => {
  const worker = new Worker(new URL("./support/stateMarksPlanWorker.ts", import.meta.url))
  const result = await new Promise<{
    marks: { events: Array<{ eventId: string; slotId: string; versionId: string }> }
    schema: Array<{ name: string }>
    stamp: Array<{ lcm_stamp: number }>
    plans: Array<Array<{ detail: string }>>
  }>((resolve, reject) => {
    let result: Parameters<typeof resolve>[0] | undefined
    worker.once("message", (value: typeof result) => (result = value))
    worker.once("error", reject)
    worker.once("exit", (code) =>
      code === 0 && result ? resolve(result) : reject(new Error(`LCM path plan worker exited ${code}`))
    )
  })
  assert.deepStrictEqual(result.schema.map((r) => r.name).sort(), ["st_import_stage", "versions_lcm_inputs"])
  assert.isNumber(result.stamp[0]!.lcm_stamp)
  assert.deepStrictEqual(
    result.marks.events.map(({ eventId, slotId, versionId }) => ({ eventId, slotId, versionId })),
    [{ eventId: "mark", slotId: "s0", versionId: "v1" }]
  )
  assert.isNotEmpty(result.plans)
  const details = result.plans.flat().map((r) => r.detail)
  for (const index of ["state_events_chain", "state_events_position"]) {
    assert.isTrue(
      details.some((detail) => detail.includes(index)),
      JSON.stringify(details)
    )
  }
  assert.isTrue(
    details.some((detail) => /^SEARCH fx_s\b/.test(detail)),
    JSON.stringify(details)
  )
  // Scanning the bounded path_events CTE (ev) is expected; the base event table (e) must seek.
  assert.isFalse(
    details.some((detail) => /^SCAN (?:e|so)\b/.test(detail)),
    JSON.stringify(details)
  )
})
