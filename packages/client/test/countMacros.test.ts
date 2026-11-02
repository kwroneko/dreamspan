// Token counts expand macros first, as ST's character panel does (countMacros.ts).
import { describe, expect, it, vi } from "vitest"
import { countedText } from "../src/features/editor/countMacros.ts"

// The hook's connections to the app, which a test without a page has none of.
vi.mock("../src/features/editor/store.ts", () => ({ useWorkingDoc: () => ({}) }))

describe("counted text", () => {
  const names = { user: "Juniper", char: "Wren" }

  it("counts {{char}} and {{user}} as the names they become", () => {
    expect(countedText("{{char}} greets {{user}}.", names, {})).toBe("Wren greets Juniper.")
  })

  it("reads the card's own fields for {{description}} and the like", () => {
    expect(countedText("Remember: {{personality}}", names, { personality: "Patient." })).toBe("Remember: Patient.")
  })

  it("leaves text without macros as it is", () => {
    expect(countedText("The lamp is lit.", names, {})).toBe("The lamp is lit.")
  })
})
