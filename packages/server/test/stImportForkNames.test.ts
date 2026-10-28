import { assert, describe, it } from "@effect/vitest"
import { stForkName } from "../src/importer/stMapping.ts"

const DATE = "2026-3-14@09h26m53s589ms"

describe("stForkName", () => {
  it("gives no name for ST's own names", () => {
    for (const name of [
      `Branch #12 - ${DATE}`,
      "Checkpoint #3 - 2024-07-12@01h31m37s",
      "Bookmark #2 - 2023-6-19@14h20m12s",
      "Bookmark #2 - 2023-6-19 @14h 20m 12s 123ms",
      "   "
    ]) {
      assert.isNull(stForkName(name), name)
    }
    assert.isNull(stForkName(`Bot - ${DATE} - Branch #1`, `Bot - ${DATE}`))
    assert.isNull(stForkName("A renamed chat - Checkpoint #4", "A renamed chat"))
  })
  it("keeps the user's name without ST's date", () => {
    assert.strictEqual(stForkName(`Before the duel - ${DATE}`), "Before the duel")
    assert.strictEqual(stForkName("Before the duel - 2023-6-19@14h20m12s"), "Before the duel")
    assert.strictEqual(stForkName("The duel, won"), "The duel, won")
    assert.strictEqual(stForkName("Branch #2 is better"), "Branch #2 is better")
    assert.strictEqual(stForkName("x".repeat(150)), "x".repeat(100))
  })
})
