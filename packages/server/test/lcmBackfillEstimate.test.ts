// The backfill estimate's arithmetic (spec/LCM.md §2.11) apart from any chat: the worked
// example of the spec, and the rules it follows from the planner.
import { assert, describe, it } from "@effect/vitest"
import { backfillSeconds, estimateBackfill } from "../src/lcm/backfill.ts"

/** 750k tokens before the window, and the window (three quarters of 120k) after them. */
const story = {
  tokens: 840_000,
  messages: 3360,
  windowMax: 120_000,
  layerMax: 30_000,
  prefix: 6000,
  layer: 0,
  leafInput: 4000,
  leafTarget: 600,
  fanout: 5,
  condenseTarget: 800,
  cached: true,
  cacheWrites: false
}

describe("estimateBackfill", () => {
  it("matches the worked example: a 750k-token story is about 190 summaries and a quarter as many condensations", () => {
    const totals = estimateBackfill(story)
    // The spec's figures are rounded: 188 + 46 jobs, 0.95M uncached, 2.4M cached, 0.15M returned.
    assert.closeTo(totals.l1Jobs, 188, 25)
    assert.closeTo(totals.condensations, 46, 10)
    assert.closeTo(totals.uncachedInput, 950_000, 250_000)
    assert.closeTo(totals.cachedInput, 2_400_000, 700_000)
    assert.closeTo(totals.output, 150_000, 20_000)
  })

  it("without a cache everything is sent afresh, about the story times the layer and the prefix", () => {
    const totals = estimateBackfill({ ...story, cached: false })
    assert.strictEqual(totals.cachedInput, 0)
    assert.closeTo(totals.uncachedInput, 3_400_000, 700_000)
  })

  it("summarizes nothing while the window is under its trigger, and keeps the newest half", () => {
    assert.strictEqual(estimateBackfill({ ...story, tokens: 80_000, messages: 320 }).l1Jobs, 0)
    const some = estimateBackfill({ ...story, tokens: 100_000, messages: 400 })
    assert.isAbove(some.l1Jobs, 0)
    // The window ends under its trigger: what is summarized is at least the excess over it.
    assert.isAtLeast(some.summarized, 100_000 - 120_000 * 0.75)
    assert.isAtMost(some.summarized, 100_000 - 120_000 * 0.5)
  })

  it("charges cache writes for the prefix and the summaries added, where the price has them", () => {
    const priced = estimateBackfill({ ...story, cacheWrites: true })
    const free = estimateBackfill(story)
    assert.isAbove(priced.cacheWrite, story.prefix)
    assert.isBelow(priced.uncachedInput, free.uncachedInput)
    assert.strictEqual(priced.cachedInput, free.cachedInput)
  })

  it("costs more the more the story has, and a smaller window needs more passes", () => {
    const small = estimateBackfill({ ...story, tokens: 200_000, messages: 800 })
    const large = estimateBackfill(story)
    assert.isBelow(small.uncachedInput, large.uncachedInput)
    assert.isBelow(small.l1Jobs, large.l1Jobs)
  })

  it("takes its duration from the model's speed, and none without a history", () => {
    const totals = estimateBackfill(story)
    assert.isNull(backfillSeconds(totals, null))
    const seconds = backfillSeconds(totals, { latencyS: 2, tokensPerSecond: 50 })!
    assert.closeTo(seconds, totals.requests * 2 + totals.output / 50, 1)
    // About one to two hours for the example, one request at a time.
    assert.isAbove(seconds, 1800)
  })

  it("includes the planner's 128-slot limit when messages are short", () => {
    const totals = estimateBackfill({ ...story, tokens: 400_000, messages: 100_000 })
    assert.isAtLeast(totals.l1Jobs, Math.ceil(totals.summarized / (128 * 4)))
  })

  it("handles an empty chat and a missing window", () => {
    assert.strictEqual(estimateBackfill({ ...story, tokens: 0, messages: 0 }).l1Jobs, 0)
    assert.strictEqual(estimateBackfill({ ...story, windowMax: 0 }).l1Jobs, 0)
  })
})
