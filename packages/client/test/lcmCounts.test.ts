import { expect, test } from "vitest"
import type { LcmState } from "@rp/shared/lcm.ts"
import { countsOf, healthOf } from "../src/features/chat/lcm.ts"

test("a terminal summary and its failed job count as one failed range", () => {
  const state = {
    layer: [],
    failed: [{ level: 1, from: 1, to: 4, rerun: false }],
    jobs: [{ id: "failed-attempt", level: 1, from: 1, to: 4, status: "failed", rerun: false }]
  } as unknown as LcmState
  expect(countsOf(state).failed).toBe(1)
  expect(countsOf({ ...state, jobs: [...state.jobs, { ...state.jobs[0]!, id: "other-level", level: 2 }] }).failed).toBe(
    2
  )
})

test("retained failed lineage is shown as resolved after successful coverage", () => {
  expect(healthOf({ status: "failed", fresh: true, resolved: true })).toBe("resolved")
})
