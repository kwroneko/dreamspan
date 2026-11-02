import { expect, test } from "vitest"
import type { LcmState } from "@rp/shared/lcm.ts"
import { countsOf, failureText, healthOf, userTextKept } from "../src/features/chat/lcm.ts"

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

test("a failed redo of a summary the user edited isn't counted on the divider: the user's text stays in use", () => {
  const state = {
    layer: [{ level: 1, from: 1, to: 4, origin: "user", rerun: false, fresh: true, status: "complete" }],
    failed: [{ level: 1, from: 1, to: 4, rerun: false }],
    jobs: [{ id: "failed-redo", level: 1, from: 1, to: 4, status: "failed", rerun: false }]
  } as unknown as LcmState
  // Owner, 2026-11-02: it's listed only in the Summaries tab, under Failed, with Retry.
  expect(countsOf(state).failed).toBe(0)
  expect(userTextKept(state, state.failed[0]!)).toBe(true)
  // A generated or imported summary there, or the user's over another range, doesn't keep it.
  for (const layer of [
    [{ ...state.layer[0]!, origin: "generated" }],
    [{ ...state.layer[0]!, origin: "imported" }],
    [{ ...state.layer[0]!, to: 8 }]
  ])
    expect(countsOf({ ...state, layer } as unknown as LcmState).failed).toBe(1)
})

test("retained failed lineage is shown as resolved after successful coverage", () => {
  expect(healthOf({ status: "failed", fresh: true, resolved: true })).toBe("resolved")
})

test("a failure reads as words, never as the stored JSON", () => {
  // As a job records it: its class and message, the provider's own body after the status.
  const stored = JSON.stringify({
    class: "overloaded",
    message: '500: {"message":"The upstream model is overloaded."}'
  })
  expect(failureText(stored)).toBe("The provider was busy: The upstream model is overloaded. (HTTP 500)")
  expect(failureText(JSON.stringify({ class: "refused", message: '400: {"error":{"message":"Declined."}}' }))).toBe(
    "The model refused: Declined. (HTTP 400)"
  )
  expect(failureText(JSON.stringify({ class: "something-new", message: "It broke." }))).toBe("It broke.")
  // A job's plain text stays as it is.
  expect(failureText("The model refused three times.")).toBe("The model refused three times.")
})
