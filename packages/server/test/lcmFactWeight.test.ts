import { assert, it } from "@effect/vitest"
import { factRowCharacters } from "../src/db/lcmFactWeight.ts"

it("accounts for failed-summary errors, audiences and input identities in retained facts", () => {
  const error = JSON.stringify({ message: "Synthetic error details. ".repeat(50_000) })
  const row = { id: "summary", content: "", error_json: error, audience_json: JSON.stringify(["character"]) }
  assert.isAtLeast(factRowCharacters(row), error.length + row.audience_json.length)
  const input = {
    summary_id: "s".repeat(36),
    slot_id: "p".repeat(36),
    version_id: "v".repeat(36),
    parent_slot_id: "a".repeat(36),
    ordinal: 0
  }
  assert.isAtLeast(factRowCharacters(input), 4 * 36)
})
