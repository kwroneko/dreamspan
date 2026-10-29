import { expect, it } from "vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import { register } from "../src/features/cardRename/index.tsx"
import { cardSavedContribution, cardSavedContributions } from "../src/features/editor/cardSaved.ts"
import { cardContributions } from "../src/features/cardForks/surfaces.tsx"
import { chatCardActions } from "../src/features/chat/presentation.tsx"

it("offers renames only for an effective model-name change and lets plugins replace or disable the flow", () => {
  const disposers = register()
  const change = { entityId: "synthetic" as EntityId, oldName: "Aria", newName: "Ari" }
  try {
    const original = cardSavedContribution(change)!
    expect(original.id).toBe("card-rename.history")
    expect(cardSavedContribution({ ...change, newName: "Aria" })).toBeUndefined()
    expect(cardSavedContribution({ ...change, oldName: "" })).toBeUndefined()
    expect(cardContributions.get("card-rename.resume")).toBeDefined()
    expect(chatCardActions.get("card-rename.resume")).toBeDefined()
    const restore = cardSavedContributions.disable(original.id)
    expect(cardSavedContribution(change)).toBeUndefined()
    restore()
    const override = cardSavedContributions.register({ ...original, applies: () => false })
    expect(cardSavedContribution(change)).toBeUndefined()
    override()
    expect(cardSavedContribution(change)).toBe(original)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
  expect(cardSavedContribution(change)).toBeUndefined()
})
