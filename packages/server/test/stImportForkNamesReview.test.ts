import { assert, describe, it } from "@effect/vitest"
import { stForkName } from "../src/importer/stMapping.ts"

describe("ST fork name preservation", () => {
  it("keeps a user-supplied current ST checkpoint called Branch #42", () => {
    for (const name of ["Branch #42", "Checkpoint #42", "Bookmark #42", "2026-3-14@09h26m53s589ms"]) {
      assert.strictEqual(stForkName(name), name)
    }
  })
  it("keeps suffixes that cannot be generated from the actual parent", () => {
    for (const name of [
      "Unrelated - Branch #42",
      "Unrelated - Checkpoint #42",
      "main - Bookmark #42",
      "main - Branch #0"
    ]) {
      assert.strictEqual(stForkName(name, "main"), name)
      assert.strictEqual(stForkName(name), name)
    }
  })
  it("recognizes current names only with their actual parent's generator rules", () => {
    for (const [parent, name] of [
      ["main", "main - Branch #1"],
      ["main", "main - Checkpoint #2"],
      ["main - Branch #9", "main - Branch #10"],
      ["main - Checkpoint #9", "main - Checkpoint #10"],
      ["Branch #2 - main", "main - Branch #1"],
      ["Checkpoint #2 - main", "main - Checkpoint #1"],
      ["main - Branch #2", "main - Branch #2 - Checkpoint #1"],
      ["雪の道 [a.*]", "雪の道 [a.*] - Branch #1"]
    ]) {
      assert.isNull(stForkName(name!, parent!))
      assert.strictEqual(stForkName(name!, "different parent"), name)
      assert.strictEqual(stForkName(name!), name)
    }
  })
  it("preserves non-ASCII and does not strip an unrelated date format", () => {
    assert.strictEqual(stForkName("雪の道 — Café 🌙 - 2026-03-14"), "雪の道 — Café 🌙 - 2026-03-14")
    assert.strictEqual(stForkName("🌙".repeat(60)), "🌙".repeat(50))
  })
})
