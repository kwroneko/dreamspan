import { expect, test } from "vitest"
import { cardChoiceLabel } from "../src/features/chat/CardVersion.tsx"

test("compact card choices use the standard display name and version, leaving absent versions out", () => {
  expect(cardChoiceLabel({ name: "Mira", subtitle: " Summer coast " })).toBe("Mira · Summer coast")
  expect(cardChoiceLabel({ name: "Mira", subtitle: "Winter keep" })).toBe("Mira · Winter keep")
  expect(cardChoiceLabel({ name: "Mira", subtitle: "  " })).toBe("Mira")
})
