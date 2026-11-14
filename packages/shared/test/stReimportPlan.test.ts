import { assert, it } from "@effect/vitest"
import type { ChatId } from "../src/chat.ts"
import { stPlanAffectedBySkip } from "../src/stReimportPlan.ts"

it("does not promise counts based on writes from a skipped earlier file", () => {
  const a = "00000000-0000-4000-8000-000000000001" as ChatId
  const b = "00000000-0000-4000-8000-000000000002" as ChatId
  const files = [
    { path: "Main", chatId: a },
    { path: "Unrelated", chatId: b },
    { path: "Side", chatId: a },
    { path: "Nested", chatId: a }
  ]
  assert.deepStrictEqual([...stPlanAffectedBySkip(files, new Set(["Main"]))], ["Side", "Nested"])
  assert.deepStrictEqual([...stPlanAffectedBySkip(files, new Set(["Side"]))], ["Nested"])
  assert.deepStrictEqual([...stPlanAffectedBySkip(files, new Set(["Nested"]))], [])
  assert.deepStrictEqual([...stPlanAffectedBySkip(files, new Set(files.map((f) => f.path)))], [])
  assert.deepStrictEqual([...stPlanAffectedBySkip(files, new Set())], [])
})
