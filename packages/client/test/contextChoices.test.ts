import { describe, expect, it } from "vitest"
import { contextChoices } from "../src/features/chat/contextChoices.ts"

const views = [
  { id: "shared", label: "One shared context", description: "Every reply sees the whole chat." },
  { id: "separate", label: "Separate contexts", description: "Each character sees what it was there for." }
]

describe("the Context setting's choices", () => {
  it("is one shared context when the chat names none", () => {
    const { value, options } = contextChoices({ contextViews: views })
    expect(value).toBe("shared")
    expect(options.map((o) => o.value)).toEqual(["shared", "separate"])
  })
  it("follows the chat's view, and a change being written", () => {
    expect(contextChoices({ contextPerSpeaker: "separate", contextViews: views }).value).toBe("separate")
    expect(contextChoices({ contextPerSpeaker: "separate", contextViews: views }, "shared").value).toBe("shared")
  })
  it("names a view that isn't installed, first, saying what happens meanwhile", () => {
    const { value, options } = contextChoices({ contextPerSpeaker: "threads", contextViews: views })
    expect(value).toBe("threads")
    expect(options[0]).toEqual({
      value: "threads",
      label: "threads (not installed)",
      description: "Until it's back, each reply sees only what its speaker was there for."
    })
    expect(options).toHaveLength(3)
  })
})
