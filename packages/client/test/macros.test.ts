// Macros in displayed text (features/chat/macros.ts): a greeting's random and time macros
// show what they drew when it was first shown, whatever the clock says later (DESIGN §5.6).
import { afterEach, describe, expect, it, vi } from "vitest"
import { displayText, expandForDisplay } from "../src/features/chat/macros.ts"

const names = { user: "Ana", char: "Mira" }

afterEach(() => vi.restoreAllMocks())

describe("display macros", () => {
  it("show a template's frozen time values again, a day later", () => {
    const text = "At {{datetimeformat::YYYY-MM-DD HH:mm}}, {{user}} arrives."
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2025, 0, 1, 12, 0))
    const first = expandForDisplay(text, "template", names)
    expect(Object.keys(first.frozen)).not.toHaveLength(0)
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2025, 0, 2, 13, 0))
    expect(displayText(text, "template", names, {}, first.frozen)).toBe(first.text)
    // Without them, the clock shows through: that's what freezing is for.
    expect(displayText(text, "template", names)).not.toBe(first.text)
  })

  it("read the speaker card's fields, and never expand verbatim text", () => {
    expect(displayText("Note: {{description}}", "template", names, { description: "A harbor pilot." })).toBe(
      "Note: A harbor pilot."
    )
    expect(displayText("Note: {{description}}", "verbatim", names, { description: "A harbor pilot." })).toBe(
      "Note: {{description}}"
    )
  })
})
