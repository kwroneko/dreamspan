import { describe, expect, it } from "vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { contextChoices, JOINS_READ_WHOLE } from "../src/features/chat/contextChoices.ts"
import { replyDetail } from "../src/features/chat/ReplyFrom.tsx"

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
  it("says on one shared context, while another is on, that earlier joins are then read whole", () => {
    const shared = (current?: string) =>
      contextChoices({ ...(current ? { contextPerSpeaker: current } : {}), contextViews: views }).options[0]!
    expect(shared("separate").description).toBe(`Every reply sees the whole chat. ${JOINS_READ_WHOLE}`)
    expect(shared().description).toBe("Every reply sees the whole chat.")
    expect(shared("shared").description).toBe("Every reply sees the whole chat.")
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

describe("Next's line for an away character", () => {
  const wren = "wren" as EntityId
  const mira = "mira" as EntityId
  it("says away, muted, both or neither", () => {
    expect(replyDetail(wren, [], [wren])).toBe("Away: replies only when picked")
    expect(replyDetail(wren, [wren], [wren])).toBe("Away and muted: replies only when picked")
    expect(replyDetail(mira, [mira], [wren])).toBe("Muted: replies only when picked")
    expect(replyDetail(mira, [], [wren])).toBe("Replies next, for one reply")
  })
})
